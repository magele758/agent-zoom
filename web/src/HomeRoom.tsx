import { MessageDelegate } from "./Delegation";
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import type { CompanyIndex } from "../../src/company-types";
import type { HomeRoomBinding, HomeRoomPost, HomeRoomTarget } from "../../src/home-room-types";
import { extractIdeaId, LinkedText } from "./InternalLinks";
import { api, request } from "./api";
import "./home-room.css";

type IdeaCitation = {
  id: string;
  title: string;
  body: string;
  sources: { reference: string; body: string }[];
};

const base = "/api/opc/home-rooms";
const label = (e: unknown) => (e instanceof Error ? e.message : "无法读取讨论");
const submit = (data: object) => ({ method: "POST", body: JSON.stringify(data) });
const address = (id: string) => base + "/" + encodeURIComponent(id);
type Index = { bindings: HomeRoomBinding[]; localRooms: { id: string; name: string; project: string }[] };
type Directory = { rooms: HomeRoomTarget[]; bots: { id: string; name: string }[] };
const receipts = {
  sending: "正在送达",
  unknown: "回执待核对",
  retryable: "核对后未找到原帖",
  received: "已送达原房间",
};

function BindRoom({ localRooms, saved }: { localRooms: Index["localRooms"]; saved: (item: HomeRoomBinding) => void }) {
  const [catalog, setCatalog] = useState<Directory>();
  const [localRoom, setLocal] = useState("");
  const [remoteRoom, setRemote] = useState("");
  const [botId, setBot] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    const abort = new AbortController();
    request<Directory>(base + "/directory", { signal: abort.signal })
      .then(setCatalog)
      .catch((e) => {
        if (!abort.signal.aborted) setError(label(e));
      });
    return () => abort.abort();
  }, [refresh]);
  const room = catalog?.rooms.find((r) => r.id === remoteRoom);
  const bind = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      saved(await request<HomeRoomBinding>(base, submit({ localRoom, remoteRoom, botId })));
    } catch (err) {
      setError(label(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="hr-bind" onSubmit={bind}>
      <fieldset disabled={busy}>
        <legend>关联已有房间</legend>
        <label>
          OPC OS 频道
          <select required value={localRoom} onChange={(e) => setLocal(e.target.value)}>
            <option value="">选择本地频道</option>
            {localRooms.map((r) => (
              <option key={r.id} value={r.id}>
                {r.project ? r.project + " / " : ""}
                {r.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Agent Home 讨论房间
          <select
            required
            value={remoteRoom}
            onChange={(e) => {
              setRemote(e.target.value);
              setBot("");
            }}
          >
            <option value="">{catalog ? "选择活动讨论房间" : "正在读取房间"}</option>
            {catalog?.rooms.map((r) => (
              <option key={r.id} value={r.id}>
                {r.title}
              </option>
            ))}
          </select>
        </label>
        <label>
          接收消息的 Bot
          <select required value={botId} onChange={(e) => setBot(e.target.value)}>
            <option value="">选择房间成员</option>
            {catalog?.bots
              .filter((b) => room?.botIds.includes(b.id))
              .map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
          </select>
        </label>
        <button className="hr-primary" disabled={!botId || !localRoom} type="submit">
          保存关联
        </button>
      </fieldset>
      {catalog && !catalog.rooms.length && <p>请先在 Agent Home 建立讨论房间并加入 Bot。</p>}
      {!localRooms.length && (
        <p>
          请先到 <a href="#channels">频道</a> 建立项目房间。
        </p>
      )}
      {error && (
        <p role="alert">
          {error}{" "}
          {!catalog && (
            <button
              type="button"
              onClick={() => {
                setError("");
                setRefresh((n) => n + 1);
              }}
            >
              重新读取
            </button>
          )}
        </p>
      )}
    </form>
  );
}

function formatIdeaPrompt(idea: IdeaCitation) {
  const quote = idea.sources[0];
  return [
    `围绕想法「${idea.title}」讨论：`,
    idea.body,
    quote ? `引用材料：${quote.reference}\n${quote.body.slice(0, 320)}` : "",
    `来源：#ideas?idea=${idea.id}`,
  ]
    .filter(Boolean)
    .join("\n");
}

function stageLinkForPost(binding: HomeRoomBinding, post: HomeRoomPost) {
  const ideaId = extractIdeaId(post.body);
  const query = new URLSearchParams({
    step: ideaId ? "idea" : "research",
    refBinding: binding.id,
    refPost: post.id,
  });
  if (ideaId) query.set("item", ideaId);
  return "#stage?" + query;
}

function Discussion({
  binding,
  highlightPost = "",
  ideaCitation,
  onClearIdea,
}: {
  binding: HomeRoomBinding;
  highlightPost?: string;
  ideaCitation?: IdeaCitation | null;
  onClearIdea?: () => void;
}) {
  const [posts, setPosts] = useState<HomeRoomPost[]>();
  const [body, setBody] = useState("");
  const [parent, setParent] = useState<HomeRoomPost>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);
  const ticket = useRef<{ text: string; key: string } | null>(null);
  const appliedIdea = useRef("");
  const scrolledPost = useRef("");
  const path = address(binding.id);
  useEffect(() => {
    if (!ideaCitation || appliedIdea.current === ideaCitation.id) return;
    appliedIdea.current = ideaCitation.id;
    setBody((current) => (current.trim() ? current : formatIdeaPrompt(ideaCitation)));
  }, [ideaCitation]);
  useEffect(() => {
    if (!highlightPost || !posts?.some((p) => p.id === highlightPost) || scrolledPost.current === highlightPost) return;
    scrolledPost.current = highlightPost;
    document.getElementById("hr-post-" + highlightPost)?.scrollIntoView({ block: "nearest" });
  }, [highlightPost, posts]);
  useEffect(() => {
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      if (!document.hidden) {
        try {
          const result = await request<{ posts: HomeRoomPost[] }>(path + "/messages", { signal: abort.signal });
          if (!abort.signal.aborted) setPosts(result.posts);
        } catch (err) {
          if (!abort.signal.aborted) setError(label(err));
        }
      }
      if (!abort.signal.aborted) timer = setTimeout(poll, 3500);
    };
    const onVisible = () => {
      if (!document.hidden) {
        clearTimeout(timer);
        void poll();
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    void poll();
    return () => {
      abort.abort();
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [path, reload]);
  const action = async (run: () => Promise<unknown>) => {
    setError("");
    setBusy(true);
    try {
      await run();
      setReload((n) => n + 1);
    } catch (err) {
      setError(label(err));
    } finally {
      setBusy(false);
    }
  };
  const send = (e: FormEvent) => {
    e.preventDefault();
    if (busy || !body.trim()) return;
    const text = JSON.stringify([body.trim(), parent?.id]);
    if (ticket.current?.text !== text) ticket.current = { text, key: crypto.randomUUID() };
    const key = ticket.current.key;
    void action(async () => {
      await request(path + "/messages", submit({ key, body, parent: parent?.id }));
      setBody("");
      setParent(undefined);
      ticket.current = null;
      if (ideaCitation) onClearIdea?.();
    });
  };
  return (
    <article className="hr-discussion">
      <header>
        <div>
          <span>{binding.project}</span>
          <h2>{binding.roomTitle}</h2>
        </div>
        <button disabled={busy} onClick={() => void action(() => request(path + "/reconcile", submit({})))}>
          核对原房间
        </button>
      </header>
      {binding.problem && <p role="status">{binding.problem}</p>}
      <ol className="hr-posts">
        {posts?.map((post) => {
          const original = posts.find((p) => p.id === post.parent);
          return (
            <li key={post.id} id={"hr-post-" + post.id} data-highlighted={post.id === highlightPost || undefined}>
              <div>
                <strong>{post.direction === "in" ? binding.botName : "发给 @" + binding.botName}</strong>
                <time dateTime={post.createdAt}>
                  {new Date(post.createdAt).toLocaleString("zh-CN", {
                    month: "numeric",
                    day: "numeric",
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </time>
              </div>
              {original && <blockquote>{original.body.slice(0, 110)}</blockquote>}
              <p>
                <LinkedText text={post.body} />
              </p>
              {Boolean(post.question) && <MessageDelegate messageId={"home-room:" + post.id} />}
              <div className="hr-post-actions">
                {post.direction === "in" ? (
                  <button disabled={busy} onClick={() => setParent(post)}>
                    引用回复
                  </button>
                ) : (
                  <small>
                    {receipts[post.state]}{" "}
                    {post.state === "retryable" && (
                      <button
                        disabled={busy}
                        onClick={() =>
                          void action(() =>
                            request(path + "/messages/" + encodeURIComponent(post.id) + "/retry", submit({})),
                          )
                        }
                      >
                        重试这条消息
                      </button>
                    )}
                  </small>
                )}
                <a className="hr-stage-link" href={stageLinkForPost(binding, post)}>
                  转为阶段任务 ↗
                </a>
              </div>
            </li>
          );
        })}
      </ol>
      {posts && posts.length === 0 && <p>发出第一条消息后，@{binding.botName} 的回复会出现在这里。</p>}
      {ideaCitation && (
        <div className="hr-idea-cite">
          <div>
            <strong>引用想法 · {ideaCitation.title}</strong>
            <a href={"#ideas?idea=" + encodeURIComponent(ideaCitation.id)}>查看原想法与日记 ↗</a>
          </div>
          {ideaCitation.sources[0] && (
            <blockquote>
              {ideaCitation.sources[0].reference}：{ideaCitation.sources[0].body.slice(0, 160)}
            </blockquote>
          )}
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              onClearIdea?.();
              if (body === formatIdeaPrompt(ideaCitation)) setBody("");
            }}
          >
            取消引用
          </button>
        </div>
      )}
      <form className="hr-compose" onSubmit={send}>
        {parent && (
          <div>
            <blockquote>
              回复 {binding.botName} · {parent.body.slice(0, 120)}
            </blockquote>
            <button type="button" disabled={busy} onClick={() => setParent(undefined)}>
              取消引用
            </button>
          </div>
        )}
        <label>
          发给 @{binding.botName}
          <textarea
            required
            maxLength={16000}
            rows={3}
            value={body}
            disabled={busy}
            onChange={(e) => setBody(e.target.value)}
          />
        </label>
        <button type="submit" className="hr-primary" disabled={busy || !body.trim()}>
          发送到原房间
        </button>
      </form>
      {error && <p role="alert">{error}</p>}
    </article>
  );
}

export function HomeRoom({ project = "", nav }: { project?: string; nav?: ReactNode }) {
  const [index, setIndex] = useState<Index>();
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  const params = new URLSearchParams(location.hash.split("?")[1]);
  const deepLink = params.get("binding") ?? "";
  const highlightPost = params.get("post") ?? "";
  const ideaParam = params.get("idea") ?? "";
  const [selected, setSelected] = useState(deepLink);
  const [ideaCitation, setIdeaCitation] = useState<IdeaCitation | null>(null);
  useEffect(() => {
    setSelected(deepLink);
  }, [deepLink, project]);
  useEffect(() => {
    if (!ideaParam) {
      setIdeaCitation(null);
      return;
    }
    const abort = new AbortController();
    api
      .companyIndex(abort.signal)
      .then((company: CompanyIndex) => {
        if (abort.signal.aborted) return;
        const found = company.ideas.find((item) => item.id === ideaParam);
        if (!found) {
          setIdeaCitation(null);
          return;
        }
        const sources = company.information
          .filter((note) => found.sources.includes(note.id))
          .map((note) => ({ reference: note.reference || note.title, body: note.body || note.title }));
        setIdeaCitation({ id: found.id, title: found.title, body: found.body, sources });
      })
      .catch(() => {
        if (!abort.signal.aborted) setIdeaCitation(null);
      });
    return () => abort.abort();
  }, [ideaParam]);
  useEffect(() => {
    const abort = new AbortController();
    request<Index>(base, { signal: abort.signal })
      .then(setIndex)
      .catch((e) => {
        if (!abort.signal.aborted) setError(label(e));
      });
    return () => abort.abort();
  }, [reload]);
  const matchesProject = (value: string) =>
    !project || value === project || value === project.split("/")[0] || project.startsWith(value + "/");
  const matchedRooms = index?.bindings.filter((b) => matchesProject(b.project)) ?? [];
  const fallbackAll = Boolean(project && index && !matchedRooms.length && index.bindings.length);
  const rooms = fallbackAll ? (index?.bindings ?? []) : matchedRooms;
  const binding = selected ? rooms.find((b) => b.id === selected) : rooms[0];
  return (
    <section className="zo-product hr-page">
      <header className="zo-product-head">
        {nav}
        <div>
          <a href="#overview">全局看板 ↗</a>
          <h1>项目讨论室</h1>
        </div>
      </header>
      <div className="hr-body">
        <p className="hr-intro">
          选定项目频道和 Agent Home 房间成员后，可以点名讨论。Bot 标记的待决问题会进入
          <a href="#inbox?filter=pending">待我处理</a>。
        </p>
        {fallbackAll && (
          <p role="status" className="hr-intro">
            项目「{project}」尚未单独关联讨论室，以下列出已有讨论室，也可以先新建关联。
          </p>
        )}
        {error && (
          <p role="alert">
            {error}{" "}
            <button
              onClick={() => {
                setError("");
                setReload((n) => n + 1);
              }}
            >
              重试
            </button>
          </p>
        )}
        <div className="hr-toolbar">
          <label>
            已关联讨论
            <select value={binding?.id ?? ""} onChange={(e) => setSelected(e.target.value)}>
              {!rooms.length && <option value="">暂无关联</option>}
              {rooms.map((b) => (
                <option value={b.id} key={b.id}>
                  {b.project} / {b.roomTitle} · @{b.botName}
                </option>
              ))}
            </select>
          </label>
          <button disabled={!index} onClick={() => setAdding(!adding)}>
            {adding ? "收起" : "关联房间和 Bot"}
          </button>
        </div>
        {adding && index && (
          <BindRoom
            localRooms={index.localRooms.filter((r) => !project || matchesProject(r.project || r.name) || fallbackAll)}
            saved={(item) => {
              setIndex({ ...index, bindings: [...index.bindings.filter((b) => b.id !== item.id), item] });
              setSelected(item.id);
              setAdding(false);
            }}
          />
        )}
        {binding && (
          <Discussion
            key={binding.id}
            binding={binding}
            highlightPost={highlightPost}
            ideaCitation={ideaCitation}
            onClearIdea={() => setIdeaCitation(null)}
          />
        )}
        {index && !binding && !adding && (
          <p>{selected ? "这条讨论在当前目录中不可见。" : "选择「关联房间和 Bot」，开始项目的第一次讨论。"}</p>
        )}
      </div>
    </section>
  );
}
