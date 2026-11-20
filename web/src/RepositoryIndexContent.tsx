import { useEffect, useRef, useState, type FormEvent } from "react";
import type { IndexedRepo, RepoContent } from "../../src/activity-index-types";
import { request } from "./api";
import { GitHubLink } from "./ProjectShelf";

type SearchResult = { items: { path: string; url: string; line?: number }[]; source: string; note: string };
const base = "/api/opc/activity-index";
export function RepositoryIndexContent({ repo }: { repo: IndexedRepo }) {
  const [data, setData] = useState<RepoContent | null>(null),
    [error, setError] = useState("");
  const [query, setQuery] = useState(""),
    [search, setSearch] = useState<(SearchResult & { query: string }) | null>(null);
  const [finding, setFinding] = useState(false),
    [searchError, setSearchError] = useState("");
  const [retry, setRetry] = useState(0);
  const findController = useRef<AbortController | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    setError("");
    setData(null);
    request<RepoContent>(base + "/content?" + new URLSearchParams({ repo: repo.fullName }), {
      signal: controller.signal,
    })
      .then((result) => {
        if (!controller.signal.aborted) setData(result);
      })
      .catch((cause) => {
        if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "暂时无法读取仓库内容");
      });
    return () => controller.abort();
  }, [repo.fullName, retry]);
  useEffect(() => () => findController.current?.abort(), []);
  const find = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const q = query.trim();
    if (!q) return;
    findController.current?.abort();
    const controller = new AbortController();
    findController.current = controller;
    setFinding(true);
    setSearchError("");
    setSearch(null);
    try {
      const result = await request<SearchResult>(
        base + "/search?" + new URLSearchParams({ repo: repo.fullName, q }),
        { signal: controller.signal },
      );
      if (!controller.signal.aborted) setSearch({ ...result, query: q });
    } catch (cause) {
      if (!controller.signal.aborted) setSearchError(cause instanceof Error ? cause.message : "搜索失败");
    } finally {
      if (!controller.signal.aborted) setFinding(false);
    }
  };
  return (
    <section className="idx-content" aria-label="仓库内容">
      <header>
        <h3>仓库内容</h3>
        {repo.url && <GitHubLink href={repo.url}>打开 GitHub ↗</GitHubLink>}
      </header>
      <form onSubmit={find} className="idx-code-search">
        <label>
          仓库内搜索
          <input
            type="search"
            value={query}
            maxLength={160}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="代码或文档中的关键词"
          />
        </label>
        <button type="submit" disabled={!query.trim() || finding}>
          {finding ? "搜索中…" : "搜索内容"}
        </button>
      </form>
      {searchError && <p role="alert">{searchError}</p>}
      {search && (
        <div className="idx-code-results" aria-label="内容搜索结果">
          <p>
            “{search.query}” · {search.source} · {search.items.length} 条匹配
          </p>
          <ul>
            {search.items.map((item, i) => (
              <li key={item.path + "-" + i}>
                <GitHubLink href={item.url}>
                  {item.path}
                  {item.line !== undefined ? " · 第 " + item.line + " 行" : ""}
                </GitHubLink>
              </li>
            ))}
          </ul>
          {search.note && <small>{search.note}</small>}
        </div>
      )}
      {error && (
        <p role="alert">
          {error}{" "}
          <button type="button" onClick={() => setRetry((n) => n + 1)}>
            重读内容
          </button>
        </p>
      )}
      {!error && !data && <p role="status">正在读取文件和 README…</p>}
      {data && (
        <>
          <p className="idx-content-meta">
            {data.source}
            {data.ref && (
              <>
                {" "}
                · 版本 <code title={data.ref}>{data.ref}</code>
              </>
            )}
          </p>
          {data.note && <p className="idx-muted">{data.note}</p>}
          <nav className="idx-filelinks" aria-label="仓库维护入口">
            {data.issuesUrl && <GitHubLink href={data.issuesUrl}>查看 Issues ↗</GitHubLink>}
            {data.pullsUrl && <GitHubLink href={data.pullsUrl}>查看 Pull requests ↗</GitHubLink>}
          </nav>
          <details className="idx-filetree" open>
            <summary>根目录 · {data.files.length} 项</summary>
            {data.files.length ? (
              <ul>
                {data.files.map((file) => (
                  <li key={file.name}>
                    <span>{file.directory ? "目录" : "文件"}</span>
                    <GitHubLink href={file.url}>{file.name}</GitHubLink>
                  </li>
                ))}
              </ul>
            ) : (
              <p>此版本没有可列出的文件。</p>
            )}
          </details>
          <section className="idx-readme">
            <header>
              <h3>README</h3>
              {data.readme?.url && <GitHubLink href={data.readme.url}>查看原文 ↗</GitHubLink>}
            </header>
            {data.readme ? (
              <>
                <pre>{data.readme.text}</pre>
                {data.readme.truncated && <small>此处显示 README 摘录。</small>}
              </>
            ) : (
              <p>此版本没有可读取的 README。</p>
            )}
          </section>
        </>
      )}
    </section>
  );
}
