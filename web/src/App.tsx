import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { groupById, GROUPS, groupLabel, groupOf } from "../../src/groups";
import { api, type Agent, type Claim, type LocalAgent, type Me, type Snapshot, type Task } from "./api";
import { mentionAtCaret, settledMentions, splitMentions } from "./mentions";

const KIND_LABEL: Record<string, string> = {
  chat: "发言",
  instruction: "指令",
  question: "提问",
  progress: "进度",
  direction: "方向",
  blocked: "卡住",
  decision: "决定",
  bid: "投标",
  deliverable: "交付",
  review: "评审",
  test_result: "测试",
  design: "方案",
  system: "系统",
};

const STATUS_LABEL: Record<string, string> = {
  open: "待认领",
  bidding: "投标中",
  claimed: "已认领",
  working: "实现中",
  in_review: "评审中",
  changes: "需修改",
  in_test: "测试中",
  done: "完成",
  dispute: "待裁定",
  failed: "失败",
  canceled: "取消",
};

const STEPS = [
  { id: "open", label: "待认领" },
  { id: "working", label: "实现" },
  { id: "in_review", label: "评审" },
  { id: "in_test", label: "测试" },
  { id: "done", label: "完成" },
];

function stepIndex(status: string) {
  if (status === "bidding") return 0;
  if (status === "claimed" || status === "changes") return 1;
  if (status === "dispute" || status === "failed") return STEPS.length - 1;
  const index = STEPS.findIndex((step) => step.id === status);
  return index === -1 ? 0 : index;
}

function stepClass(status: string, index: number, current: number) {
  if (status === "dispute" || status === "failed") return index < STEPS.length - 1 ? "done" : "";
  if (index < current || status === "done") return "done";
  if (index === current) return "now";
  return "";
}

function timeLabel(iso: string) {
  return new Date(iso).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
}

function RichBody({ body, known }: { body: string; known: Set<string> }) {
  return (
    <p>
      {splitMentions(body).map((part, index) =>
        part.handle && known.has(part.handle) ? (
          <span key={index} className="at">{part.text}</span>
        ) : (
          <span key={index}>{part.text}</span>
        ),
      )}
    </p>
  );
}

function MentionMenu({
  query,
  options,
  hiddenCount,
  active,
  onPick,
  onHover,
}: {
  query: string;
  options: Agent[];
  hiddenCount: number;
  active: number;
  onPick: (handle: string) => void;
  onHover: (index: number) => void;
}) {
  return (
    <ul className="mention-menu" id="mention-menu" role="listbox" data-testid="mention-menu">
      {options.length === 0 ? (
        <li>
          <p className="mention-empty">{query ? `没有叫 ${query} 的 agent` : "这个频道还没有 agent"}</p>
        </li>
      ) : (
        options.map((agent, index) => (
          <li key={agent.id} role="presentation">
            <button
              type="button"
              role="option"
              id={`mention-option-${agent.handle}`}
              aria-selected={index === active}
              className={index === active ? "active" : ""}
              data-testid={`mention-option-${agent.handle}`}
              onMouseDown={(event) => {
                event.preventDefault();
                onPick(agent.handle);
              }}
              onMouseEnter={() => onHover(index)}
            >
              <i className={agent.online ? "dot on" : "dot"} aria-hidden="true" />
              <strong>@{agent.handle}</strong>
              <em>
                {agent.online ? "在线" : "离线"}
                {agent.demo ? " · 演示" : agent.runtime ? ` · ${agent.runtime}` : ""}
                {` · Lv${agent.level ?? 1}`}
              </em>
            </button>
          </li>
        ))
      )}
      {hiddenCount > 0 ? <li className="mention-more">还有 {hiddenCount} 个，继续输入</li> : null}
    </ul>
  );
}

export function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [booting, setBooting] = useState(true);
  const [roomId, setRoomId] = useState<string | null>(null);
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [error, setError] = useState("");
  const [mobile, setMobile] = useState<"rooms" | "chat" | "tasks">("chat");

  const loadMe = useCallback(async () => {
    const next = await api.me();
    setMe(next);
    setRoomId((current) => current ?? next.rooms[0]?.id ?? null);
  }, []);

  useEffect(() => {
    api.me().then((next) => {
      setMe(next);
      setRoomId(next.rooms[0]?.id ?? null);
    }).catch(() => setMe(null)).finally(() => setBooting(false));
  }, []);

  const refresh = useCallback(async () => {
    if (!roomId) return;
    try {
      const next = await api.snapshot(roomId);
      setSnap(next);
      setError("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "加载失败");
    }
  }, [roomId]);

  useEffect(() => {
    if (!snap) return;
    setMe((current) => {
      if (!current) return current;
      const existing = current.rooms.find((room) => room.id === snap.room.id);
      if (!existing) return current;
      const same =
        existing.project === snap.room.project &&
        existing.branch === snap.room.branch &&
        (existing.directories ?? []).join("\n") === (snap.room.directories ?? []).join("\n") &&
        existing.topic === snap.room.topic &&
        (existing.currentTopic ?? "") === (snap.room.currentTopic ?? "") &&
        Boolean(existing.general) === Boolean(snap.room.general) &&
        Boolean(existing.archived) === Boolean(snap.room.archived) &&
        Boolean(existing.direct) === Boolean(snap.room.direct);
      if (same) return current;
      return {
        ...current,
        rooms: current.rooms.map((room) =>
          room.id === snap.room.id
            ? {
                ...room,
                project: snap.room.project,
                directories: snap.room.directories,
                branch: snap.room.branch,
                topic: snap.room.topic,
                currentTopic: snap.room.currentTopic ?? "",
                general: Boolean(snap.room.general),
                archived: Boolean(snap.room.archived),
                direct: Boolean(snap.room.direct),
              }
            : room,
        ),
      };
    });
  }, [snap]);

  useEffect(() => {
    if (!roomId) return;
    void refresh();
    const timer = setInterval(() => {
      void refresh();
      void loadMe();
    }, 5000);
    return () => clearInterval(timer);
  }, [roomId, refresh, loadMe]);

  useEffect(() => {
    if (!me || !roomId) return;
    let socket: WebSocket | null = null;
    let closed = false;
    let retry: ReturnType<typeof setTimeout>;
    const connect = () => {
      const protocol = location.protocol === "https:" ? "wss" : "ws";
      socket = new WebSocket(`${protocol}://${location.host}/ws`);
      socket.onopen = () => socket?.send(JSON.stringify({ type: "watch", roomId }));
      socket.onmessage = () => void refresh();
      socket.onclose = () => {
        if (!closed) retry = setTimeout(connect, 1500);
      };
    };
    connect();
    return () => {
      closed = true;
      clearTimeout(retry);
      socket?.close();
    };
  }, [me, roomId, refresh]);

  if (booting) return <main className="gate"><p>正在打开工位…</p></main>;
  if (!me) return <Gate onEnter={async (name) => { await api.enter(name); await loadMe(); }} />;

  return (
    <div className="shell">
      <div className={`sidebar ${mobile === "rooms" ? "on" : ""}`}>
        <div className="brand">
          <span className="mark">工位</span>
          <span className="org">{me.orgs[0]?.name ?? "工作室"}</span>
        </div>
        <RoomList
          rooms={me.rooms}
          active={roomId}
          onPick={(id) => {
            setRoomId(id);
            setMobile("chat");
          }}
          onCreated={async (id) => {
            await loadMe();
            setRoomId(id);
            setMobile("chat");
          }}
        />
        <button className="text-button leave" type="button" onClick={() => api.logout().then(() => location.reload())}>
          离开
        </button>
      </div>
      <main className={`stage ${mobile === "chat" ? "on" : ""}`}>
        <Channel
          meName={me.user.name}
          snap={snap}
          error={error}
          onPosted={() => void refresh()}
          onError={setError}
        />
      </main>
      <aside className={`side ${mobile === "tasks" ? "on" : ""}`}>
        {snap ? (
          <SidePanel
            snap={snap}
            onChanged={() => {
              void refresh();
              void loadMe();
            }}
            onError={setError}
            onMention={(handle) => {
              window.dispatchEvent(new CustomEvent("mention", { detail: handle }));
              setMobile("chat");
            }}
          />
        ) : (
          <p className="muted">选择一个频道</p>
        )}
      </aside>
      <nav className="mobile-nav" aria-label="面板">
        <button type="button" className={mobile === "rooms" ? "active" : ""} onClick={() => setMobile("rooms")}>频道</button>
        <button type="button" className={mobile === "chat" ? "active" : ""} onClick={() => setMobile("chat")}>消息</button>
        <button type="button" className={mobile === "tasks" ? "active" : ""} onClick={() => setMobile("tasks")}>任务</button>
      </nav>
    </div>
  );
}

function Gate({ onEnter }: { onEnter: (name: string) => Promise<void> }) {
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  return (
    <main className="gate">
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          setPending(true);
          setError("");
          try {
            await onEnter(name);
          } catch (reason) {
            setError(reason instanceof Error ? reason.message : "进不去");
          } finally {
            setPending(false);
          }
        }}
      >
        <div className="gate-copy">
          <p className="eyebrow">Agent Chatroom</p>
          <h1>工位</h1>
          <p className="lede">一个频道里放人和 coding agent。你下指令，他们自己认领，别的 agent 评审、提问、测试。</p>
        </div>
        <div className="gate-plate">
          <label htmlFor="name">你的名字</label>
          <input id="name" data-testid="name-input" value={name} onChange={(event) => setName(event.target.value)} placeholder="比如 彭磊" autoFocus />
          {error ? <p className="error">{error}</p> : null}
          <button data-testid="enter" type="submit" disabled={pending || !name.trim()}>进入工作室</button>
        </div>
      </form>
    </main>
  );
}

function directoryLines(value: string) {
  return value.split(/\n+/).map((line) => line.trim()).filter(Boolean);
}

function scopeText(scope: { project?: string; directories?: string[]; branch?: string }) {
  return [
    scope.project ? `项目 ${scope.project}` : "未指定项目",
    scope.directories?.length ? scope.directories.join("、") : "未指定目录",
    scope.branch ? `分支 ${scope.branch}` : "",
  ].filter(Boolean).join(" · ");
}

function RoomList({
  rooms,
  active,
  onPick,
  onCreated,
}: {
  rooms: Me["rooms"];
  active: string | null;
  onPick: (id: string) => void;
  onCreated: (id: string) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [topic, setTopic] = useState("");
  const [currentTopic, setCurrentTopic] = useState("");
  const [project, setProject] = useState("");
  const [directories, setDirectories] = useState("");
  const [branch, setBranch] = useState("");
  const openRooms = rooms.filter((room) => !room.archived && !room.direct);
  const directRooms = rooms.filter((room) => room.direct && !room.archived);
  const archivedRooms = rooms.filter((room) => room.archived && !room.direct);
  const roomItem = (room: Me["rooms"][number]) => (
    <li key={room.id}>
      <button type="button" className={room.id === active ? "room active" : "room"} onClick={() => onPick(room.id)}>
        <span>{room.name}</span>
        {room.direct ? <small>私聊</small> : room.project ? <small>{room.project}</small> : null}
      </button>
    </li>
  );
  return (
    <div className="rooms">
      <div className="section-row">
        <h2>频道</h2>
        <button type="button" className="icon-button" aria-label="新建频道" onClick={() => setOpen((value) => !value)}>
          <Plus />
        </button>
      </div>
      {open ? (
        <form
          className="stack-form"
          onSubmit={async (event) => {
            event.preventDefault();
            const room = await api.createRoom({
              name,
              topic,
              currentTopic,
              project,
              directories: directoryLines(directories),
              branch,
            });
            setName("");
            setTopic("");
            setCurrentTopic("");
            setProject("");
            setDirectories("");
            setBranch("");
            setOpen(false);
            await onCreated(room.id);
          }}
        >
          <input aria-label="频道名" value={name} onChange={(event) => setName(event.target.value)} placeholder="频道名" />
          <input aria-label="说明" value={topic} onChange={(event) => setTopic(event.target.value)} placeholder="这个频道用来做什么" />
          <input aria-label="当前主题" value={currentTopic} onChange={(event) => setCurrentTopic(event.target.value)} placeholder="当前主题" />
          <input aria-label="项目" value={project} onChange={(event) => setProject(event.target.value)} placeholder="项目名，比如 agent-zoom" />
          <textarea aria-label="工作目录" value={directories} onChange={(event) => setDirectories(event.target.value)} placeholder={"工作目录，一行一个\nweb/src"} />
          <input aria-label="分支" value={branch} onChange={(event) => setBranch(event.target.value)} placeholder="默认分支，比如 main" />
          <button type="submit" disabled={!name.trim()}>创建</button>
        </form>
      ) : null}
      <ul>{openRooms.map(roomItem)}</ul>
      {directRooms.length > 0 ? (
        <div className="direct-rooms" data-testid="direct-list">
          <div className="section-row">
            <h2>私聊</h2>
          </div>
          <ul>{directRooms.map(roomItem)}</ul>
        </div>
      ) : null}
      {archivedRooms.length > 0 ? (
        <details className="archived-rooms">
          <summary>已归档</summary>
          <ul>{archivedRooms.map(roomItem)}</ul>
        </details>
      ) : null}
    </div>
  );
}

function Channel({
  meName,
  snap,
  error,
  onPosted,
  onError,
}: {
  meName: string;
  snap: Snapshot | null;
  error: string;
  onPosted: () => void;
  onError: (message: string) => void;
}) {
  const [body, setBody] = useState("");
  const [acceptance, setAcceptance] = useState("");
  const [parallel, setParallel] = useState(false);
  const [complex, setComplex] = useState(false);
  const [tags, setTags] = useState("");
  const [kind, setKind] = useState<"chat" | "question" | "instruction">("instruction");
  const [taskId, setTaskId] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [editingScope, setEditingScope] = useState(false);
  const [editingText, setEditingText] = useState(false);
  const [topicDraft, setTopicDraft] = useState("");
  const [currentTopicDraft, setCurrentTopicDraft] = useState("");
  const [project, setProject] = useState("");
  const [directories, setDirectories] = useState("");
  const [branch, setBranch] = useState("");
  const [caret, setCaret] = useState(0);
  const [mentionActive, setMentionActive] = useState(0);
  const [dismissedQuery, setDismissedQuery] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  const stick = useRef(true);
  const pendingCaret = useRef<number | null>(null);

  useEffect(() => {
    const onMention = (event: Event) => {
      const handle = (event as CustomEvent<string>).detail;
      setBody((current) => {
        const next = `${current}${current && !/\s$/.test(current) ? " " : ""}@${handle} `;
        pendingCaret.current = next.length;
        return next;
      });
      setDismissedQuery(null);
      box.current?.focus();
    };
    window.addEventListener("mention", onMention);
    return () => window.removeEventListener("mention", onMention);
  }, []);

  useEffect(() => {
    if (pendingCaret.current == null) return;
    const pos = pendingCaret.current;
    pendingCaret.current = null;
    setCaret(pos);
    const el = box.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(pos, pos);
  }, [body]);

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    if (!snap?.messages.length) {
      el.scrollTop = 0;
      return;
    }
    if (stick.current) el.scrollTop = el.scrollHeight;
  }, [snap?.messages.length]);

  const scopeKey = snap
    ? `${snap.room.id}|${snap.room.project}|${snap.room.branch}|${(snap.room.directories ?? []).join("\n")}`
    : "";
  useEffect(() => {
    if (!snap) return;
    setEditingScope(false);
    setProject(snap.room.project ?? "");
    setDirectories((snap.room.directories ?? []).join("\n"));
    setBranch(snap.room.branch ?? "");
  }, [scopeKey]);

  useEffect(() => {
    setEditingText(false);
    setKind(snap?.room.direct ? "question" : "instruction");
  }, [snap?.room.id, snap?.room.direct]);

  const at = mentionAtCaret(body, caret);
  const queryKey = at ? `${at.start}:${at.query}` : "";
  const menuOpen = at !== null && dismissedQuery !== queryKey;
  const ranked = useMemo(() => {
    const agents = snap?.members.agents ?? [];
    const query = at?.query ?? "";
    return agents
      .filter((agent) => !query || agent.handle.toLowerCase().startsWith(query))
      .sort((a, b) => {
        const group = (agent: Agent) => (agent.demo ? 2 : 0) + (agent.online ? 0 : 1);
        const rank = group(a) - group(b);
        if (rank) return rank;
        return a.handle.localeCompare(b.handle);
      });
  }, [snap, at?.query]);
  const options = ranked.slice(0, 8);
  const hiddenCount = Math.max(0, ranked.length - options.length);
  const activeIndex = options.length === 0 ? 0 : Math.min(mentionActive, options.length - 1);
  const knownHandles = useMemo(
    () => new Set((snap?.members.agents ?? []).map((agent) => agent.handle.toLowerCase())),
    [snap],
  );
  const settled = settledMentions(body, caret);
  const hit = settled.filter((handle) => knownHandles.has(handle));
  const miss = settled.filter((handle) => !knownHandles.has(handle));

  useEffect(() => {
    setMentionActive(0);
  }, [queryKey]);

  const insertHandle = (handle: string) => {
    if (!at) return;
    const next = `${body.slice(0, at.start)}@${handle} ${body.slice(caret)}`;
    pendingCaret.current = at.start + handle.length + 2;
    setBody(next);
    setDismissedQuery(null);
  };

  const selected = snap?.tasks.find((task) => task.id === taskId) ?? null;
  const latest = snap?.messages.at(-1);
  const changeArchived = async (archived: boolean) => {
    if (!snap) return;
    try {
      await api.setArchived(snap.room.id, archived);
      onPosted();
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : archived ? "没能归档" : "没能取消归档");
    }
  };

  return (
    <>
      <header className="channel-head">
        <div>
          <h1>{snap?.room.name ?? "频道"}</h1>
          <p>{snap?.room.topic}</p>
          {snap?.room.currentTopic?.trim() ? (
            <p className="current-topic" data-testid="current-topic">当前：{snap.room.currentTopic}</p>
          ) : null}
          {snap?.room.direct ? (
            <p className="direct-note" data-testid="direct-note">只有参与者能看到这段对话。频道里的其他人看不到。</p>
          ) : snap ? (
            <p className="scope" data-testid="room-scope">{scopeText(snap.room)}</p>
          ) : null}
          {snap && !snap.room.direct && editingText ? (
            <form
              className="scope-form"
              onSubmit={async (event) => {
                event.preventDefault();
                try {
                  await api.setChannelText(snap.room.id, {
                    topic: topicDraft.trim(),
                    currentTopic: currentTopicDraft.trim(),
                  });
                  setEditingText(false);
                  onPosted();
                } catch (reason) {
                  onError(reason instanceof Error ? reason.message : "没能保存说明");
                }
              }}
            >
              <input aria-label="说明" value={topicDraft} onChange={(event) => setTopicDraft(event.target.value)} placeholder="这个频道用来做什么" />
              <input aria-label="当前主题" value={currentTopicDraft} onChange={(event) => setCurrentTopicDraft(event.target.value)} placeholder="当前主题" />
              <span className="scope-actions">
                <button type="submit">保存说明</button>
                <button type="button" className="text-button" onClick={() => setEditingText(false)}>取消</button>
              </span>
            </form>
          ) : snap && !snap.room.direct ? (
            <button
              type="button"
              className="text-button"
              data-testid="edit-channel-text"
              onClick={() => {
                setTopicDraft(snap.room.topic ?? "");
                setCurrentTopicDraft(snap.room.currentTopic ?? "");
                setEditingText(true);
              }}
            >
              改说明
            </button>
          ) : null}
          {snap && !snap.room.direct && editingScope ? (
            <form
              className="scope-form"
              onSubmit={async (event) => {
                event.preventDefault();
                try {
                  await api.setScope(snap.room.id, {
                    project,
                    directories: directoryLines(directories),
                    branch,
                  });
                  setEditingScope(false);
                  onPosted();
                } catch (reason) {
                  onError(reason instanceof Error ? reason.message : "没能保存工作范围");
                }
              }}
            >
              <input aria-label="项目" value={project} onChange={(event) => setProject(event.target.value)} placeholder="项目名" />
              <textarea aria-label="工作目录" value={directories} onChange={(event) => setDirectories(event.target.value)} placeholder={"工作目录，一行一个"} />
              <input aria-label="分支" value={branch} onChange={(event) => setBranch(event.target.value)} placeholder="默认分支" />
              <span className="scope-actions">
                <button type="submit">保存范围</button>
                <button type="button" className="text-button" onClick={() => setEditingScope(false)}>取消</button>
              </span>
            </form>
          ) : snap && !snap.room.direct ? (
            <button type="button" className="text-button" data-testid="edit-scope" onClick={() => setEditingScope(true)}>改工作范围</button>
          ) : null}
          {snap && !snap.room.general && !snap.room.archived && !snap.room.direct ? (
            <button type="button" className="text-button" data-testid="archive-room" onClick={() => void changeArchived(true)}>
              归档频道
            </button>
          ) : null}
        </div>
        <span className="you">你是 {meName}</span>
      </header>
      <div
        className="transcript"
        data-testid="transcript"
        ref={scroller}
        onScroll={(event) => {
          const el = event.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
      >
        {snap && snap.messages.length === 0 ? (
          <p className="empty">还没有消息。用「下指令」发一条需求。只有一位空闲 agent 匹配时会直接认领，多位就先投标。</p>
        ) : null}
        {snap?.messages.map((message) =>
          message.kind === "system" ? (
            <p key={message.id} className="system">{message.body}<span>{timeLabel(message.createdAt)}</span></p>
          ) : (
            <article key={message.id} className={`msg kind-${message.kind} ${message.taskId && message.taskId === taskId ? "linked" : ""}`}>
              <div className="msg-meta">
                <strong>{message.authorName}</strong>
                <span className="pill">{KIND_LABEL[message.kind] ?? message.kind}</span>
                {message.taskTitle ? (
                  <button type="button" className="linkish" onClick={() => setTaskId(message.taskId)}>
                    {message.taskTitle}
                  </button>
                ) : null}
                <time dateTime={message.createdAt}>{timeLabel(message.createdAt)}</time>
              </div>
              <RichBody body={message.body} known={knownHandles} />
            </article>
          ),
        )}
        <p className="sr" aria-live="polite">{latest ? `${latest.authorName} ${KIND_LABEL[latest.kind] ?? ""} ${latest.body}` : ""}</p>
      </div>
      {error ? <p className="error banner">{error}</p> : null}
      {snap?.room.archived ? (
        <div className="composer">
          <p className="fine">这个频道已归档。历史还在。</p>
          <button type="button" className="text-button" data-testid="unarchive-room" onClick={() => void changeArchived(false)}>
            取消归档
          </button>
        </div>
      ) : (
      <form
        className="composer"
        onSubmit={async (event) => {
          event.preventDefault();
          if (!snap || !body.trim()) return;
          setPending(true);
          try {
            await api.post(snap.room.id, {
              body,
              kind,
              taskId: kind === "instruction" ? null : taskId,
              acceptance: kind === "instruction" ? acceptance : undefined,
              parallel: kind === "instruction" ? parallel : undefined,
              tags: kind === "instruction" ? tags : undefined,
              complex: kind === "instruction" ? complex : undefined,
            });
            setBody("");
            setAcceptance("");
            setTags("");
            setParallel(false);
            setComplex(false);
            onPosted();
          } catch (reason) {
            onError(reason instanceof Error ? reason.message : "发送失败");
          } finally {
            setPending(false);
          }
        }}
      >
        <div className="kinds" role="radiogroup" aria-label="消息类型">
          {(
            snap?.room.direct
              ? ([
                  ["question", "提问"],
                  ["chat", "发言"],
                ] as const)
              : ([
                  ["instruction", "下指令"],
                  ["chat", "发言"],
                  ["question", "提问"],
                ] as const)
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={kind === value}
              className={kind === value ? "active" : ""}
              data-testid={`kind-${value}`}
              onClick={() => setKind(value)}
            >
              {label}
            </button>
          ))}
        </div>
        {selected && kind !== "instruction" ? (
          <p className="thread-hint">
            发进「{selected.title}」，会唤醒占着槽位的 agent。
            <button type="button" onClick={() => setTaskId(null)}>取消</button>
          </p>
        ) : null}
        {kind === "instruction" && snap && !snap.room.archived && !(snap.room.directories?.length) ? (
          <p className="scope-hint" data-testid="scope-hint">这个频道还没有工作目录。项目请另开频道，填上目录和分支。大厅只适合公告。</p>
        ) : null}
        {kind === "instruction" ? (
          <div className="composer-extra">
            <label className="sr" htmlFor="acceptance">验收</label>
            <textarea
              id="acceptance"
              data-testid="acceptance"
              rows={2}
              value={acceptance}
              placeholder="验收标准。不填就用上面的指令。"
              onChange={(event) => setAcceptance(event.target.value)}
            />
            <label className="sr" htmlFor="task-tags">标签</label>
            <input
              id="task-tags"
              data-testid="task-tags"
              type="text"
              value={tags}
              placeholder="标签，用逗号分开。不填时，有设计身份就先出方案，否则空闲 agent 都能做"
              onChange={(event) => setTags(event.target.value)}
            />
            <label className="checkline">
              <input
                data-testid="parallel"
                type="checkbox"
                checked={parallel}
                onChange={(event) => setParallel(event.target.checked)}
              />
              并行方案，最多 3 条。各自隔离，都通过后留给人裁定
            </label>
            <label className="checkline">
              <input
                data-testid="complex"
                type="checkbox"
                checked={complex}
                onChange={(event) => setComplex(event.target.checked)}
              />
              复杂任务。有等级 3 及以上的空闲 agent 时只交给他们，没有就退回全体
            </label>
          </div>
        ) : null}
        <label className="sr" htmlFor="composer">消息</label>
        <div className="mention-field">
          {menuOpen ? (
            <MentionMenu
              query={at.query}
              options={options}
              hiddenCount={hiddenCount}
              active={activeIndex}
              onPick={insertHandle}
              onHover={setMentionActive}
            />
          ) : null}
          <textarea
            id="composer"
            data-testid="composer"
            ref={box}
            rows={3}
            value={body}
            aria-autocomplete="list"
            aria-expanded={menuOpen}
            aria-controls={menuOpen ? "mention-menu" : undefined}
            aria-activedescendant={menuOpen && options[activeIndex] ? `mention-option-${options[activeIndex].handle}` : undefined}
            placeholder={
              snap?.room.direct
                ? "只有这段私聊里的人能看到。输入 @ 会列出可以叫醒的 agent。"
                : kind === "instruction"
                  ? "写下要做完的需求。不点名时，频道里的 agent 都会收到这句。输入 @ 只叫醒那一个。"
                  : "写给房间。不点名时，频道里的 agent 都会收到。输入 @ 只叫醒那一个。"
            }
            onChange={(event) => {
              setBody(event.target.value);
              setCaret(event.target.selectionStart ?? 0);
            }}
            onClick={(event) => setCaret(event.currentTarget.selectionStart ?? 0)}
            onKeyUp={(event) => setCaret(event.currentTarget.selectionStart ?? 0)}
            onSelect={(event) => setCaret(event.currentTarget.selectionStart ?? 0)}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing || event.key === "Process") return;
              if (menuOpen && options.length > 0) {
                if (event.key === "ArrowDown") {
                  event.preventDefault();
                  setMentionActive((index) => (Math.min(index, options.length - 1) + 1) % options.length);
                  return;
                }
                if (event.key === "ArrowUp") {
                  event.preventDefault();
                  setMentionActive((index) => (Math.min(index, options.length - 1) - 1 + options.length) % options.length);
                  return;
                }
                if (event.key === "Enter" || event.key === "Tab") {
                  event.preventDefault();
                  insertHandle(options[activeIndex].handle);
                  return;
                }
              }
              if (menuOpen && event.key === "Escape") {
                event.preventDefault();
                setDismissedQuery(queryKey);
                return;
              }
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                event.currentTarget.form?.requestSubmit();
              }
            }}
          />
        </div>
        {hit.length > 0 || miss.length > 0 ? (
          <p className="mention-hint" data-testid="mention-hint">
            {hit.length > 0 ? (
              <>
                将叫醒{" "}
                {hit.map((handle, index) => (
                  <span key={handle}>
                    {index > 0 ? "、" : null}
                    <code>@{handle}</code>
                  </span>
                ))}
                。
              </>
            ) : null}
            {miss.length > 0 ? (
              <span className="miss">{miss.map((handle) => `@${handle}`).join("、")} 不在这个频道，不会有人收到。</span>
            ) : null}
          </p>
        ) : null}
        <div className="composer-bar">
          <span>{menuOpen && options.length > 0 ? "↑↓ 选择，Enter 填入，Esc 关闭" : "Enter 发送，Shift+Enter 换行"}</span>
          <button data-testid="send" type="submit" disabled={pending || !body.trim()}>发送</button>
        </div>
      </form>
      )}
    </>
  );
}

const ROLE_DUTY: Record<string, string> = {
  implementer: "实现",
  reviewer: "评审",
  tester: "测试",
};

function dutyParts(agentId: string, tasks: Task[]) {
  const parts: string[] = [];
  const walk = (task: Task) => {
    for (const claim of task.claims) {
      if (claim.agentId !== agentId) continue;
      if (claim.state && claim.state !== "active") continue;
      parts.push(`${ROLE_DUTY[claim.role] ?? claim.role}「${task.title}」`);
    }
    for (const lane of task.lanes ?? []) walk(lane);
  };
  for (const task of tasks) walk(task);
  return parts;
}

function statusLine(agent: Agent, tasks: Task[]) {
  const duties = dutyParts(agent.id, tasks);
  const duty = duties.length > 0 ? duties.join("、") : agent.paused ? "已停下" : "空闲";
  const identity = groupLabel(agent.tags) || "未分组";
  const kind = agent.demo ? "演示" : agent.runtime && agent.runtime !== agent.handle ? agent.runtime : "";
  return kind ? `${identity} · ${duty} · ${kind}` : `${identity} · ${duty}`;
}

function rosterGroups(snap: Snapshot) {
  const byOwner = new Map<string, Agent[]>();
  for (const agent of snap.members.agents) {
    const name = agent.ownerName?.trim() || "未署名";
    const list = byOwner.get(name) ?? [];
    list.push(agent);
    byOwner.set(name, list);
  }
  for (const list of byOwner.values()) {
    list.sort((a, b) => Number(Boolean(a.demo)) - Number(Boolean(b.demo)) || a.handle.localeCompare(b.handle));
  }
  const seen = new Set<string>();
  const groups: Array<{ key: string; name: string; online: boolean; person: boolean; agents: Agent[] }> = [];
  for (const user of snap.members.users) {
    seen.add(user.name);
    groups.push({
      key: user.id,
      name: user.name,
      online: user.online,
      person: true,
      agents: byOwner.get(user.name) ?? [],
    });
  }
  for (const [name, agents] of byOwner) {
    if (seen.has(name)) continue;
    groups.push({
      key: `owner:${name}`,
      name,
      online: agents.some((agent) => Boolean(agent.online)),
      person: false,
      agents,
    });
  }
  return groups;
}

function groupMeta(person: boolean, count: number) {
  if (person && count > 0) return `人 · ${count} 个 agent`;
  if (person) return "人";
  return `${count} 个 agent`;
}

function holderText(claim: Claim, agents: Agent[]) {
  const agent = agents.find((item) => item.id === claim.agentId);
  const who = claim.ownerName ? `${claim.ownerName} / ${claim.handle}` : claim.handle;
  const identity = agent ? groupLabel(agent.tags) : "";
  const level = agent && agent.level != null ? `Lv${agent.level}` : "";
  return [who, identity, level].filter(Boolean).join(" · ");
}

function labelList(ids: string[]) {
  return ids.map((id) => groupById(id)?.label ?? id).join("、");
}

function LocalAgents({
  roomId,
  joined,
  onChanged,
  onError,
}: {
  roomId: string;
  joined: string;
  onChanged: () => void;
  onError: (message: string) => void;
}) {
  const [agents, setAgents] = useState<LocalAgent[]>([]);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [levels, setLevels] = useState<Record<string, number>>({});
  const [groups, setGroups] = useState<Record<string, string>>({});
  const openButtonRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const opened = useRef(false);

  useEffect(() => {
    let cancelled = false;
    let timer = 0;
    const load = (attempt: number) => {
      api
        .localAgents(roomId)
        .then((data) => {
          if (cancelled) return;
          setAgents(data.agents);
          setState("ready");
        })
        .catch(() => {
          if (cancelled) return;
          if (attempt < 4) {
            timer = window.setTimeout(() => load(attempt + 1), 800);
            return;
          }
          setState("error");
        });
    };
    load(0);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [roomId, joined]);

  useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = previous;
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  useEffect(() => {
    if (open) {
      opened.current = true;
      return;
    }
    if (opened.current) openButtonRef.current?.focus();
  }, [open]);

  const connected = agents.filter((agent) => agent.connected).length;
  const countLabel =
    state === "error" && agents.length === 0 ? "没读到" : state === "loading" && agents.length === 0 ? "查找中" : `${connected}/${agents.length} 已接入`;
  const bars =
    agents.length > 0
      ? agents
      : Array.from({ length: 8 }, (_, index) => ({ id: `pad-${index}`, connected: false, writable: false }));

  return (
    <>
      <button
        type="button"
        className="machine-chart"
        data-testid="open-local-agents"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`这台电脑，${countLabel}`}
        ref={openButtonRef}
        onClick={() => setOpen(true)}
      >
        <span className="bars" aria-hidden="true">
          {bars.map((agent) => (
            <span
              key={agent.id}
              className={agent.connected ? "bar on" : "bar"}
              style={{ height: agent.connected ? "100%" : agent.writable ? "68%" : "40%" }}
            />
          ))}
        </span>
        <span className="chart-meta">
          <strong>这台电脑</strong>
          <em>{countLabel}</em>
        </span>
      </button>
      {open
        ? createPortal(
            <div className="local-backdrop" onClick={() => setOpen(false)}>
              <div
                role="dialog"
                aria-modal="true"
                aria-labelledby="local-agent-title"
                data-testid="local-agent-dialog"
                className="local-dialog"
                onClick={(event) => event.stopPropagation()}
              >
                <div className="section-row">
                  <h2 id="local-agent-title">这台电脑</h2>
                  <button type="button" className="text-button" data-testid="local-agent-close" ref={closeRef} onClick={() => setOpen(false)}>
                    关闭
                  </button>
                </div>
                <p className="fine">点接入会把它写进该客户端的配置，并加入当前频道。接入时选定身份和等级。课题研究、产品设计师、设计师、技术架构师先出方案，不改代码；方案齐了再交给实现。复杂任务仍是等级 3 及以上优先。</p>
                {state === "loading" && agents.length === 0 ? <p className="fine">正在查找这台电脑上的客户端。</p> : null}
                {state === "error" ? <p className="fine">没能读到这台电脑上的客户端。</p> : null}
                {state === "ready" && agents.length === 0 ? <p className="fine">这台电脑上没找到可接入的客户端。</p> : null}
                {agents.length > 0 ? (
                  <ul className="local-agents" data-testid="local-agent-list">
                    {agents.map((agent) => {
                      const action = agent.connected ? "已接入" : agent.writable ? "接入" : "仅显示";
                      const pickLevel = agent.writable && !agent.connected;
                      const groupId = groups[agent.id] ?? "build";
                      return (
                        <li key={agent.id} data-testid={`local-agent-${agent.id}`}>
                          <div className="who">
                            <strong>{agent.label}</strong>
                            <span className="handle-name">@{agent.handle}</span>
                            <em>{agent.detail}</em>
                          </div>
                          <div className="local-actions">
                            {pickLevel ? (
                              <select
                                className="local-group"
                                aria-label={`${agent.label} 的身份`}
                                data-testid={`local-agent-group-${agent.id}`}
                                value={groupId}
                                disabled={busy !== null}
                                onChange={(event) => setGroups((current) => ({ ...current, [agent.id]: event.target.value }))}
                              >
                                {GROUPS.map((group) => (
                                  <option key={group.id} value={group.id}>
                                    {group.label}
                                  </option>
                                ))}
                              </select>
                            ) : null}
                            {pickLevel ? (
                              <select
                                className="local-level"
                                aria-label={`${agent.label} 的接入等级`}
                                data-testid={`local-agent-level-${agent.id}`}
                                value={levels[agent.id] ?? 1}
                                disabled={busy !== null}
                                onChange={(event) => setLevels((current) => ({ ...current, [agent.id]: Number(event.target.value) }))}
                              >
                                {[1, 2, 3, 4, 5].map((level) => (
                                  <option key={level} value={level}>
                                    Lv{level}
                                  </option>
                                ))}
                              </select>
                            ) : null}
                            <button
                              type="button"
                              className="local-add"
                              data-testid={`local-agent-add-${agent.id}`}
                              disabled={agent.connected || !agent.writable || busy !== null}
                              onClick={async () => {
                                setBusy(agent.id);
                                try {
                                  const result = await api.connectLocalAgent(roomId, agent.id, levels[agent.id] ?? 1, groups[agent.id] ?? "build");
                                  setNote(result.note);
                                  onChanged();
                                } catch (reason) {
                                  onError(reason instanceof Error ? reason.message : "没能接入");
                                } finally {
                                  setBusy(null);
                                }
                              }}
                            >
                              {busy === agent.id ? "接入中" : action}
                            </button>
                          </div>
                          {pickLevel ? (
                            <em className="group-cap" data-testid={`local-agent-capability-${agent.id}`}>
                              {groupById(groupId)?.capability}
                            </em>
                          ) : null}
                        </li>
                      );
                    })}
                  </ul>
                ) : null}
                {note ? (
                  <p className="fine" data-testid="local-agent-note">
                    {note}
                  </p>
                ) : null}
                <p className="fine">接入之后，要完全退出再打开那个客户端，它才会连上。已经在频道里的，身份和等级在下面在场里改。</p>
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

function SidePanel({
  snap,
  onChanged,
  onError,
  onMention,
}: {
  snap: Snapshot;
  onChanged: () => void;
  onError: (message: string) => void;
  onMention: (handle: string) => void;
}) {
  const [invite, setInvite] = useState("");
  const [code, setCode] = useState("");
  const demos = snap.members.agents.filter((agent) => agent.demo);
  const demosOn = demos.some((agent) => !agent.paused);
  const tasks = useMemo(() => [...snap.tasks].reverse(), [snap.tasks]);

  return (
    <>
      <LocalAgents
        roomId={snap.room.id}
        joined={snap.members.agents.map((agent) => agent.handle).join("\n")}
        onChanged={onChanged}
        onError={onError}
      />
      <section>
        <div className="section-row">
          <h2>在场</h2>
          {demos.length > 0 ? (
            <button
              type="button"
              className="text-button"
              data-testid="toggle-demo"
              onClick={async () => {
                try {
                  await Promise.all(demos.map((agent) => api.pause(agent.id, demosOn)));
                  onChanged();
                } catch (reason) {
                  onError(reason instanceof Error ? reason.message : "没能切换演示");
                }
              }}
            >
              {demosOn ? "暂停演示" : "继续演示"}
            </button>
          ) : null}
        </div>
        <ul className="roster" data-testid="roster">
          {rosterGroups(snap).map((group) => (
            <li key={group.key} className="person">
              <div className="person-head">
                <i className={group.online ? "dot on" : "dot"} aria-hidden="true" />
                <strong>{group.name}</strong>
                <em>{groupMeta(group.person, group.agents.length)}</em>
              </div>
              {group.agents.length > 0 ? (
                <ul className="person-agents">
                  {group.agents.map((agent) => {
                    const line = statusLine(agent, snap.tasks);
                    const where = [agent.machine, agent.cwd].filter(Boolean).join(" · ");
                    return (
                      <li key={agent.id} className="with-level">
                        <i className={agent.online ? "dot on" : "dot"} aria-hidden="true" />
                        <button
                          type="button"
                          className="handle"
                          data-testid={`roster-${agent.handle}`}
                          aria-label={`${agent.handle}，${line}`}
                          onClick={() => onMention(agent.handle)}
                        >
                          <strong>{agent.handle}</strong>
                          <em title={where || undefined}>{line}</em>
                        </button>
                        <button
                          type="button"
                          className="stop-agent"
                          data-testid={`stop-${agent.handle}`}
                          onClick={async () => {
                            try {
                              if (agent.paused) await api.pause(agent.id, false);
                              else await api.stop(agent.id);
                              onChanged();
                            } catch (reason) {
                              onError(reason instanceof Error ? reason.message : "没能停止");
                            }
                          }}
                        >
                          {agent.paused ? "继续" : "停止"}
                        </button>
                        <select
                          className="level"
                          aria-label={`${agent.handle} 的等级`}
                          data-testid={`level-${agent.handle}`}
                          value={agent.level ?? 1}
                          onChange={async (event) => {
                            try {
                              await api.setLevel(agent.id, Number(event.target.value));
                              onChanged();
                            } catch (reason) {
                              onError(reason instanceof Error ? reason.message : "没能改等级");
                            }
                          }}
                        >
                          {[1, 2, 3, 4, 5].map((level) => (
                            <option key={level} value={level}>Lv{level}</option>
                          ))}
                        </select>
                        <select
                          className="group"
                          aria-label={`${agent.handle} 的身份`}
                          data-testid={`group-${agent.handle}`}
                          value={groupOf(agent.tags)?.id ?? ""}
                          onChange={async (event) => {
                            if (!event.target.value) return;
                            try {
                              await api.setGroup(agent.id, event.target.value);
                              onChanged();
                            } catch (reason) {
                              onError(reason instanceof Error ? reason.message : "没能改身份");
                            }
                          }}
                        >
                          {groupOf(agent.tags) ? null : <option value="">未分组</option>}
                          {GROUPS.map((group) => (
                            <option key={group.id} value={group.id}>{group.label}</option>
                          ))}
                        </select>
                      </li>
                    );
                  })}
                </ul>
              ) : null}
            </li>
          ))}
        </ul>
        <p className="fine">在场按人分组。同一个人可以有多个 agent。每个 agent 有一个身份：课题研究、产品设计师、设计师、技术架构师先出方案，然后才是实现、评审、测试。身份在接入时选定，也可以在这里改。下面一行是他现在在做的事。点句柄会填上 @。复杂任务优先交给等级 3 及以上。停止会放开槽位，并拒绝下一步工具调用。客户端里已经开始的这一轮，还要在那个客户端里按停止。</p>
      </section>
      <section className="invite-block">
        <h2>成员和 agent</h2>
        <form
          className="inline"
          onSubmit={async (event) => {
            event.preventDefault();
            try {
              await api.invite(snap.room.id, invite);
              setInvite("");
              onChanged();
            } catch (reason) {
              onError(reason instanceof Error ? reason.message : "邀请失败");
            }
          }}
        >
          <input aria-label="邀请成员的名字" value={invite} onChange={(event) => setInvite(event.target.value)} placeholder="邀请成员的名字" />
          <button type="submit" disabled={!invite.trim()}>邀请</button>
        </form>
        <button
          type="button"
          className="secondary"
          data-testid="join-code"
          onClick={async () => {
            try {
              const next = await api.joinCode(snap.room.id);
              setCode(next.code);
            } catch (reason) {
              onError(reason instanceof Error ? reason.message : "生成失败");
            }
          }}
        >
          生成 agent 接入码
        </button>
        {code ? (
          <p className="code" data-testid="join-code-value">
            <code>{code}</code>
            <span>npm run enroll -- --code {code} --handle my-codex --runtime codex --tags architect --level 1 --cwd /你的/项目</span>
          </p>
        ) : null}
      </section>
      <section>
        <h2>任务</h2>
        <div data-testid="task-list">
          {tasks.length === 0 ? <p className="fine">还没有指令。</p> : null}
          {tasks.map((task) => (
            <TaskCard key={task.id} task={task} agents={snap.members.agents} onChanged={onChanged} onError={onError} />
          ))}
        </div>
        {snap.locks.length > 0 ? (
          <ul className="locks">
            {snap.locks.map((lock) => (
              <li key={lock.path}>{lock.handle} 锁着 {lock.path}</li>
            ))}
          </ul>
        ) : null}
      </section>
    </>
  );
}

function TaskCard({
  task,
  agents,
  onChanged,
  onError,
  nested = false,
  winning = false,
}: {
  task: Task;
  agents: Agent[];
  onChanged: () => void;
  onError: (message: string) => void;
  nested?: boolean;
  winning?: boolean;
}) {
  const current = stepIndex(task.status);
  const closed = task.status === "done" || task.status === "canceled";
  const lanes = task.lanes ?? [];
  const showFlow = lanes.length === 0;
  return (
    <article className={`task status-${task.status}${nested ? " lane" : ""}${winning ? " winner" : ""}`}>
      <header>
        <h3>{task.title}</h3>
        <span className="pill">{task.designPending?.length ? "出方案" : (STATUS_LABEL[task.status] ?? task.status)}</span>
      </header>
      {task.designPending?.length ? (
        <p className="note">先出方案：{labelList(task.designPending)}。他们不改代码。方案齐了再交给实现。</p>
      ) : null}
      {task.designs?.map((design, index) => (
        <p className="note" key={`${design.handle}-${index}`}>
          {design.group || "方案"} {design.handle}：{design.body}
        </p>
      ))}
      {task.acceptance && task.acceptance !== task.body ? <p className="note">验收：{task.acceptance}</p> : null}
      {task.tags && !task.designPending?.length ? (
        <p className="note">标签：{labelList(task.tags.split(/[\s,，]+/).filter(Boolean))}</p>
      ) : null}
      {task.scope && (task.scope.project || task.scope.directories.length || task.scope.branch) ? (
        <p className="note">工作范围：{scopeText(task.scope)}</p>
      ) : null}
      {task.complex && !nested ? <p className="note">复杂任务。等级 3 及以上优先，没有就退回全体匹配者。</p> : null}
      {task.direction ? <p className="note">方向：{task.direction}</p> : null}
      {task.deliverableRef ? (
        <p className="note">
          交付：<code>{task.deliverableRef}</code>
          {task.deliverableSummary ? ` ${task.deliverableSummary}` : ""}
        </p>
      ) : null}
      {task.mode === "parallel" && !nested ? <p className="note">并行方案，最多 {task.maxLanes ?? 3} 条。隔离方式由 agent 自己定。</p> : null}
      {task.status === "dispute" ? <p className="note">多条方案都通过了。放行只关掉这张卡，不会合并代码。</p> : null}
      {showFlow ? (
        <ol className="steps">
          {STEPS.map((step, index) => (
            <li key={step.id} className={stepClass(task.status, index, current)}>
              {step.label}
            </li>
          ))}
        </ol>
      ) : null}
      {showFlow ? (
        <ul className="slots">
          {(["implementer", "reviewer", "tester"] as const).map((role) => {
            const held = task.claims.filter((item) => item.role === role);
            const label = role === "implementer" ? "实现" : role === "reviewer" ? "评审" : "测试";
            return (
              <li key={role}>
                <span>{label}</span>
                <strong className={held.length ? "held" : "vacant"}>
                  {held.length ? held.map((claim) => holderText(claim, agents)).join("、") : "空"}
                </strong>
              </li>
            );
          })}
        </ul>
      ) : null}
      {lanes.length > 0 ? (
        <div className="lanes">
          {lanes.map((lane) => (
            <TaskCard
              key={lane.id}
              task={lane}
              agents={agents}
              nested
              winning={task.winnerTaskId === lane.id}
              onChanged={onChanged}
              onError={onError}
            />
          ))}
        </div>
      ) : null}
      {closed ? null : (
        <div className="task-actions">
          {task.claims
            .filter((claim) => claim.role === "implementer")
            .map((claim) => (
              <button
                key={claim.agentId}
                type="button"
                className="danger"
                data-testid={`stop-task-${claim.handle}`}
                onClick={async () => {
                  try {
                    await api.stop(claim.agentId);
                    onChanged();
                  } catch (reason) {
                    onError(reason instanceof Error ? reason.message : "没能停止");
                  }
                }}
              >
                停止 {claim.handle}
              </button>
            ))}
          {task.designPending?.length ? (
            <button
              type="button"
              data-testid={`handoff-${task.id}`}
              onClick={async () => {
                try {
                  await api.handoff(task.id);
                  onChanged();
                } catch (reason) {
                  onError(reason instanceof Error ? reason.message : "没能交给实现");
                }
              }}
            >
              交给实现
            </button>
          ) : null}
          <button
            type="button"
            onClick={async () => {
              try {
                await api.done(task.id);
                onChanged();
              } catch (reason) {
                onError(reason instanceof Error ? reason.message : "没能放行");
              }
            }}
          >
            放行
          </button>
          <button
            type="button"
            className="ghost"
            onClick={async () => {
              try {
                await api.cancel(task.id);
                onChanged();
              } catch (reason) {
                onError(reason instanceof Error ? reason.message : "没能取消");
              }
            }}
          >
            取消
          </button>
        </div>
      )}
    </article>
  );
}

function Plus() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M8 2.5v11M2.5 8h11" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}
