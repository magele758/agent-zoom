import { CoordinatorPanel } from "./CoordinatorPanel";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { groupById, GROUPS, groupLabel, groupsOf, splitTags } from "../../src/groups";
import { api, type Agent, type Claim, type LocalAgent, type Me, type Message, type Snapshot, type Task } from "./api";
import { mentionAtCaret, mentionReach, settledMentions, splitMentions } from "./mentions";
import {
  defaultKind,
  foldBody,
  isPipelineParent,
  isPipelineStep,
  PIPELINE_STATUS,
  pipelineOverview,
  shouldFold,
  stepSlots,
  stepStatus,
  stepsOf,
  type ComposerKind,
} from "./view";

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
  blocked: "等待",
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

function FoldedBody({ body, known, fold, testId }: { body: string; known: Set<string>; fold: boolean; testId?: string }) {
  const [open, setOpen] = useState(false);
  if (!fold) return <RichBody body={body} known={known} />;
  const { head, hidden } = foldBody(body);
  return (
    <div className="folded" data-testid={testId} data-open={open}>
      <RichBody body={open ? body : head} known={known} />
      <button type="button" className="text-button fold-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
        {open ? "收起" : `展开（还有 ${hidden} 字）`}
      </button>
    </div>
  );
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
  const [bootError, setBootError] = useState("");
  const [roomId, setRoomId] = useState<string | null>(null);
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [error, setError] = useState("");
  const [mobile, setMobile] = useState<"rooms" | "chat" | "tasks">("chat");
  const [channelsOpen, setChannelsOpen] = useState(() => localStorage.getItem("chatroom-channels-open") !== "false");
  const [toolsOpen, setToolsOpen] = useState(() => localStorage.getItem("chatroom-tools-open") === "true");
  useEffect(() => { localStorage.setItem("chatroom-channels-open", String(channelsOpen)); }, [channelsOpen]);
  useEffect(() => { localStorage.setItem("chatroom-tools-open", String(toolsOpen)); }, [toolsOpen]);

  useEffect(() => {
    const show = () => { setToolsOpen(true); if (window.matchMedia("(max-width: 860px)").matches) setMobile("tasks"); };
    window.addEventListener("show-task", show);
    return () => window.removeEventListener("show-task", show);
  }, []);

  const loadMe = useCallback(async () => {
    const next = await api.me();
    setMe(next);
    setRoomId((current) => current ?? next.rooms[0]?.id ?? null);
  }, []);

  useEffect(() => {
    api.me().then((next) => {
      setMe(next);
      setRoomId(next.rooms.find((room) => room.id === sessionStorage.getItem("agent-room-selected"))?.id ?? next.rooms[0]?.id ?? null);
    }).catch((reason) => {
      setMe(null);
      if (reason.status !== 401) setBootError("无法连接昆仑服务。请确认本地服务仍在运行，再重试。");
    }).finally(() => setBooting(false));
  }, []);

  const activeRoom = useRef(roomId);
  activeRoom.current = roomId;
  useEffect(() => { if (roomId) sessionStorage.setItem("agent-room-selected", roomId); }, [roomId]);

  const snapshotRequest = useRef(0);
  const refresh = useCallback(async () => {
    if (!roomId) return;
    const requestId = ++snapshotRequest.current;
    try {
      const next = await api.snapshot(roomId);
      if (activeRoom.current !== roomId || requestId !== snapshotRequest.current) return;
      setSnap(next);
      setError("");
      const through = next.messages.at(-1)?.seq;
      if (through && document.visibilityState === "visible") { void api.markRead(roomId, through).catch(() => {}); setMe((current) => current ? { ...current, rooms: current.rooms.map((room) => room.id === roomId ? { ...room, unread: 0 } : room) } : current); }
    } catch (reason) {
      if (activeRoom.current === roomId) setError(reason instanceof Error ? reason.message : "加载失败");
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
    const visible = () => { if (document.visibilityState === "visible") void refresh(); };
    document.addEventListener("visibilitychange", visible);
    return () => { clearInterval(timer); document.removeEventListener("visibilitychange", visible); };
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
  }, [me?.user.id, roomId, refresh]);

  if (booting) return <main className="gate"><p>正在打开昆仑…</p></main>;
  if (bootError) return <main className="gate"><div><p role="alert">{bootError}</p><button type="button" onClick={() => location.reload()}>重新连接</button></div></main>;
  if (!me) return <Gate onEnter={async (name) => { await api.enter(name); await loadMe(); }} />;

  return (
    <div className={`shell ${channelsOpen ? "" : "channels-collapsed"} ${toolsOpen ? "" : "tools-collapsed"}`}>
      <div className={`sidebar ${mobile === "rooms" ? "on" : ""}`}>
        <div className="brand">
          <span className="mark">昆仑</span>
          <span className="brand-description">人和 Agent 的协作空间</span>
          <span className="org">{me.orgs[0]?.name ?? "工作室"}</span>
          <small className="identity">当前身份：{me.user.name}</small>
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
        <div className="view-toolbar">
          <button type="button" data-testid="toggle-channels" aria-expanded={channelsOpen} onClick={() => setChannelsOpen(!channelsOpen)}>{channelsOpen ? "收起频道" : "展开频道"}</button>
          <button type="button" data-testid="toggle-tools" aria-expanded={toolsOpen} onClick={() => setToolsOpen(!toolsOpen)}>{toolsOpen ? "收起任务与成员" : "任务与成员"}</button>
        </div>
        <Channel
          key={roomId}
          roomId={roomId}
          meName={me.user.name}
          snap={snap?.room.id === roomId ? snap : null}
          error={error}
          onPosted={() => void refresh()}
          onError={setError}
          onClose={async () => {
            if (!roomId) return;
            try { await api.closeConversation(roomId); const next = await api.me(); setMe(next); setRoomId(next.rooms.find(room => room.general)?.id ?? next.rooms[0]?.id ?? null); }
            catch (reason) { setError(reason instanceof Error ? reason.message : "关闭失败"); }
          }}
        />
      </main>
      <aside className={`side ${mobile === "tasks" ? "on" : ""}`}>
        {snap?.room.id === roomId ? (
          <SidePanel
            key={roomId}
            snap={snap}
            onChanged={() => {
              void refresh();
              void loadMe();
            }}
            onError={setError}
            onDirect={async (handle) => {
              try { const result = await api.conversation(roomId!, handle); await loadMe(); setRoomId(result.roomId); setMobile("chat"); }
              catch (reason) { setError(reason instanceof Error ? reason.message : "私聊打开失败"); }
            }}
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
          <p className="eyebrow">人和 Agent 的协作空间</p>
          <h1>昆仑</h1>
          <p className="lede">在同一个空间交流、分工，让不同身份的 Agent 一起完成工作。</p>
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
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
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
        {room.unread ? <span className="unread" aria-label={`${room.unread} 条未读`}>{room.unread > 99 ? "99+" : room.unread}</span> : null}
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
            if (pending || !name.trim()) return;
            setPending(true); setError("");
            try {
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
            } catch (reason) { setError(reason instanceof Error ? reason.message : "创建失败"); } finally { setPending(false); }
          }}
        >
          <input aria-label="频道名" value={name} onChange={(event) => setName(event.target.value)} placeholder="频道名" />
          <input aria-label="说明" value={topic} onChange={(event) => setTopic(event.target.value)} placeholder="这个频道用来做什么" />
          <input aria-label="当前主题" value={currentTopic} onChange={(event) => setCurrentTopic(event.target.value)} placeholder="当前主题" />
          <input aria-label="项目" value={project} onChange={(event) => setProject(event.target.value)} placeholder="项目名，比如 agent-zoom" />
          <textarea aria-label="工作目录" value={directories} onChange={(event) => setDirectories(event.target.value)} placeholder={"工作目录，一行一个\nweb/src"} />
          <input aria-label="分支" value={branch} onChange={(event) => setBranch(event.target.value)} placeholder="默认分支，比如 main" />
          {error ? <p className="error" role="alert">{error}</p> : null}
          <button type="submit" disabled={pending || !name.trim()}>{pending ? "创建中…" : "创建"}</button>
          <button type="button" className="text-button" disabled={pending} onClick={() => setOpen(false)}>取消</button>
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
  roomId,
  meName,
  snap,
  error,
  onPosted,
  onError,
  onClose,
}: {
  roomId: string | null;
  meName: string;
  snap: Snapshot | null;
  error: string;
  onPosted: () => void;
  onError: (message: string) => void;
  onClose: () => Promise<void>;
}) {
  const [body, setBody] = useState(() => sessionStorage.getItem(`agent-room-draft:${roomId}`) ?? "");
  useEffect(() => { sessionStorage.setItem(`agent-room-draft:${roomId}`, body); }, [roomId, body]);
  const [acceptance, setAcceptance] = useState("");
  const [parallel, setParallel] = useState(false);
  const [complex, setComplex] = useState(false);
  const [tags, setTags] = useState("");
  const [kind, setKind] = useState<ComposerKind>(() => { const saved = sessionStorage.getItem(`agent-room-kind:${roomId}`); return saved === "instruction" || saved === "question" ? saved : "chat"; });
  useEffect(() => { sessionStorage.setItem(`agent-room-kind:${roomId}`, kind); }, [roomId, kind]);
  const [taskId, setTaskId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [searchResults, setSearchResults] = useState<Message[] | null>(null);
  const [searchPending, setSearchPending] = useState(false);
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
    const startTask = () => { setKind("instruction"); box.current?.focus(); };
    window.addEventListener("compose-task", startTask);
    return () => window.removeEventListener("compose-task", startTask);
  }, []);

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
    if (snap?.room.direct && kind === "instruction") setKind(defaultKind(true));
  }, [snap?.room.id, snap?.room.direct]);

  useEffect(() => {
    if (!roomId || !search.trim()) { setSearchResults(null); setSearchPending(false); return; }
    let cancelled = false;
    setSearchPending(true);
    const timer = setTimeout(() => {
      api.searchMessages(roomId, search).then(({ messages }) => { if (!cancelled) setSearchResults(messages); })
        .catch((reason) => { if (!cancelled) onError(reason instanceof Error ? reason.message : "搜索失败"); })
        .finally(() => { if (!cancelled) setSearchPending(false); });
    }, 250);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [roomId, search]);

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
  const { hit, miss, everyone } = mentionReach(settled, knownHandles);

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
          {snap?.room.direct ? <button type="button" className="text-button" data-testid="close-conversation" title="从你的列表移除，保留历史；之后可从成员管理重新打开" onClick={() => void onClose()}>关闭私聊</button> : null}
          <details className="channel-options"><summary>频道设置与说明</summary>
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
          </details>
        </div>
        <span className="you">你是 {meName}</span>
      </header>
      <div className="message-toolbar">
        <input type="search" aria-label="搜索频道消息" data-testid="message-search" placeholder="搜索此对话的全部历史…" value={search} onChange={(event) => setSearch(event.target.value)} />
        {search ? <span role="status">{searchPending ? "搜索中…" : `${searchResults?.length ?? 0} 条结果（最多 100 条）`}</span> : null}
        {taskId ? <button type="button" onClick={() => setTaskId(null)}>返回全部消息</button> : null}
      </div>
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
          <p className="empty">写下你要完成的事，再选择「发起任务」。接入并运行真实客户端后，才能收到它的回复和交付结果。</p>
        ) : null}
        {(searchResults ?? snap?.messages ?? []).filter((message) => !taskId || message.taskId === taskId).map((message) =>
          message.kind === "system" ? (
            <p key={message.id} className="system">{message.body}<span>{timeLabel(message.createdAt)}</span></p>
          ) : (
            <article key={message.id} className={`msg kind-${message.kind} ${message.taskId && message.taskId === taskId ? "linked" : ""}`}>
              <div className="msg-meta">
                <strong>{message.authorName}</strong>
                {message.authorType === "agent" ? <span className="pill">{message.demo ? "历史演示 · 非客户端回复" : message.runtime || "客户端"}</span> : null}
                {message.authorType === "agent" ? <span className="pill reply-identity" data-testid={`reply-identity-${message.id}`}>身份：{message.replyGroupLabel || "未指定身份"}</span> : null}
                <span className="pill">{KIND_LABEL[message.kind] ?? message.kind}</span>
                {message.taskTitle ? (
                  <button type="button" className="linkish" onClick={() => { setSearch(""); setTaskId(message.taskId); window.dispatchEvent(new CustomEvent("show-task", { detail: message.taskId })); }}>
                    {message.taskTitle}
                  </button>
                ) : null}
                <time dateTime={message.createdAt}>{timeLabel(message.createdAt)}</time>
              </div>
              <FoldedBody
                body={message.body}
                known={knownHandles}
                fold={shouldFold(message.authorType, message.kind, message.body)}
                testId={`msg-${message.kind}`}
              />
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
          if (!snap || pending || !body.trim()) return;
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
        {!snap?.room.direct ? <div className="compose-mode"><label>
          <input type="checkbox" data-testid="kind-instruction" checked={kind === "instruction"} onChange={(event) => setKind(event.target.checked ? "instruction" : "chat")} />
          创建任务
        </label>{kind === "instruction" ? <span>发送后跟踪认领、交付与验收。只填需求即可。</span> : null}</div> : null}
        {selected && kind !== "instruction" ? (
          <p className="thread-hint">
            发进「{selected.title}」，会唤醒占着槽位的 agent。
            <button type="button" onClick={() => setTaskId(null)}>取消</button>
          </p>
        ) : null}
        {kind === "instruction" ? (
          <details className="composer-extra advanced-options">
            <summary>更多任务选项（可选）</summary>
        {kind === "instruction" && snap && !snap.room.archived && !(snap.room.directories?.length) ? (
          <p className="scope-hint" data-testid="scope-hint">尚未设置工作目录；真实代码任务前请在上方「改工作范围」确认项目、目录和分支。</p>
        ) : null}

            <label className="sr" htmlFor="acceptance">验收</label>
            <textarea
              id="acceptance"
              data-testid="acceptance"
              rows={1}
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
            <div className="checkrow">
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
          </details>
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
            rows={2}
            value={body}
            aria-autocomplete="list"
            aria-expanded={menuOpen}
            aria-controls={menuOpen ? "mention-menu" : undefined}
            aria-activedescendant={menuOpen && options[activeIndex] ? `mention-option-${options[activeIndex].handle}` : undefined}
            placeholder={kind === "instruction" ? "描述要完成的任务，@ 指定客户端（可选）" : "写消息或提问，@ 指定客户端（可选）"}
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
              <span className="miss">
                {miss.map((handle) => `@${handle}`).join("、")} 不在这个频道
                {everyone ? "，没人被点名，这句会像没写 @ 一样交给频道里所有 agent。" : "，不会有人收到。"}
              </span>
            ) : null}
          </p>
        ) : null}
        <div className="composer-bar">
          <span>{menuOpen && options.length > 0 ? "↑↓ 选择，Enter 填入，Esc 关闭" : "Enter 发送，Shift+Enter 换行"}</span>
          <button data-testid="send" type="submit" disabled={pending || !snap || !body.trim()}>{pending ? "提交中…" : kind === "instruction" ? "创建任务" : "发送"}</button>
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
  const agents = snap.members.agents.filter((agent) => !agent.demo && !agent.paused).sort((a, b) => a.handle.localeCompare(b.handle));
  return [
    ...GROUPS.map((role) => ({ key: role.id, name: role.label, agents: agents.filter((agent) => groupsOf(agent.tags).some((group) => group.id === role.id)) })),
    { key: "unassigned", name: "未分配身份", agents: agents.filter((agent) => groupsOf(agent.tags).length === 0) },
  ].filter((group) => group.key !== "unassigned" || group.agents.length > 0);
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

function RoleChoices({ value, onChange, disabled, label, testId }: { value: string; onChange: (value: string) => void; disabled?: boolean; label: string; testId?: string }) {
  const selected = splitTags(value);
  return <fieldset className="role-choices" data-testid={testId} disabled={disabled}>
    <legend>{label}（可多选）</legend>
    {GROUPS.map((group) => <label key={group.id} title={group.capability}>
      <input type="checkbox" value={group.id} checked={selected.includes(group.id)} onChange={(event) => {
        const next = event.target.checked ? [...selected, group.id] : selected.filter((id) => id !== group.id);
        onChange(next.join(","));
      }} />{group.label}
    </label>)}
  </fieldset>;
}

function IdentitySettings({ agent, onChanged, onError }: { agent: Agent; onChanged: () => void; onError: (message: string) => void }) {
  const saved = groupsOf(agent.tags).map((group) => group.id).join(",");
  const [value, setValue] = useState(saved);
  const [pending, setPending] = useState(false);
  useEffect(() => setValue(saved), [saved]);
  return <div className="identity-settings">
    <RoleChoices value={value} onChange={setValue} disabled={pending} label={`${agent.handle} 的身份`} testId={`group-${agent.handle}`} />
    <button type="button" disabled={pending || !value || value === saved} onClick={async () => {
      setPending(true);
      try { await api.setGroup(agent.id, value.split(",")); onChanged(); }
      catch (reason) { onError(reason instanceof Error ? reason.message : "身份保存失败"); }
      finally { setPending(false); }
    }}>{pending ? "保存中…" : "保存身份"}</button>
  </div>;
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
      if (event.key === "Tab") {
        const dialog = document.querySelector<HTMLElement>('[data-testid="local-agent-dialog"]');
        const focusable = dialog ? [...dialog.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]')].filter((el) => el.getClientRects().length > 0) : [];
        const first = focusable[0]; const last = focusable.at(-1);
        if (first && ((event.shiftKey && document.activeElement === first) || (!event.shiftKey && document.activeElement === last) || !dialog?.contains(document.activeElement))) {
          event.preventDefault(); (event.shiftKey ? last : first)?.focus();
        }
        return;
      }
      if (event.key === "Escape") { event.preventDefault(); setOpen(false); }
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
    state === "error" && agents.length === 0 ? "没读到" : state === "loading" && agents.length === 0 ? "查找中" : `${connected}/${agents.length} 已配置并加入`;
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
                <p className="fine">选择客户端、身份和等级，接入当前频道。同一个客户端可以拥有多个身份。</p>
                <p className="fine">已配置表示本机配置与频道身份已存在。客户端能否执行任务，需要在客户端中调用工具验证。</p>
                {state === "loading" && agents.length === 0 ? <p className="fine">正在查找这台电脑上的客户端。</p> : null}
                {state === "error" ? <p className="fine">没能读到这台电脑上的客户端。</p> : null}
                {state === "ready" && agents.length === 0 ? <p className="fine">这台电脑上没找到可接入的客户端。</p> : null}
                {agents.length > 0 ? (
                  <ul className="local-agents" data-testid="local-agent-list">
                    {agents.map((agent) => {
                      const action = agent.connected ? "重写配置" : agent.writable ? "接入" : "仅显示";
                      const pickLevel = agent.writable && !agent.connected;
                      const groupId = groups[agent.id] ?? "build";
                      return (
                        <li key={agent.id} data-testid={`local-agent-${agent.id}`}>
                          <div className="who">
                            <strong>{agent.label}</strong>
                            <span className="handle-name">@{agent.handle}</span>
                            <em>{agent.detail}</em>
                            <em className="local-state">{agent.online ? "最近活跃 · " : ""}{agent.stateNote}</em>
                            {agent.inRoom && !agent.configured && agent.writable ? (
                              <em className="local-state" data-testid={`local-agent-state-${agent.id}`}>
                                房间里有同名身份 @{agent.handle}，但本机还没有它的配置。点接入写入。
                              </em>
                            ) : null}
                            {agent.configured && !agent.inRoom ? (
                              <em className="local-state" data-testid={`local-agent-state-${agent.id}`}>
                                本机已有配置，还没加入这个频道。
                              </em>
                            ) : null}
                          </div>
                          <div className="local-actions">
                            {pickLevel ? (
                              <RoleChoices value={groupId} disabled={busy !== null} label={`${agent.label} 的身份`} testId={`local-agent-group-${agent.id}`} onChange={(value) => setGroups((current) => ({ ...current, [agent.id]: value }))} />
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
                              disabled={!agent.writable || busy !== null || !groupId}
                              onClick={async () => {
                                setBusy(agent.id);
                                try {
                                  const level = levels[agent.id] ?? 1;
                                  const group = groups[agent.id] ?? "build";
                                  const result = await api.connectLocalAgent(roomId, agent.id, level, group).catch((reason: unknown) => {
                                    const code = (reason as { code?: string }).code;
                                    if (code !== "credential_other_owner") throw reason;
                                    const message = reason instanceof Error ? reason.message : "";
                                    if (!window.confirm(`${message}\n\n确定换成当前身份？`)) throw new Error("已取消，没有改动凭证");
                                    return api.connectLocalAgent(roomId, agent.id, level, group, true);
                                  });
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
                              {groupsOf(groupId).map((group) => group.capability).join(" ")}
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
  onDirect,
  snap,
  onChanged,
  onError,
  onMention,
}: {
  onDirect: (handle: string) => Promise<void>;
  snap: Snapshot;
  onChanged: () => void;
  onError: (message: string) => void;
  onMention: (handle: string) => void;
}) {
  const [focused, setFocused] = useState({ id: "", version: 0 });
  const [filter, setFilter] = useState<"active" | "attention" | "results" | "all">("active");
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>(() => {
    try { return JSON.parse(localStorage.getItem("chatroom-role-folds") || "{}"); } catch { return {}; }
  });
  useEffect(() => {
    const show = (event: Event) => { setFilter("all"); setFocused((current) => ({ id: (event as CustomEvent<string>).detail, version: current.version + 1 })); };
    window.addEventListener("show-task", show);
    return () => window.removeEventListener("show-task", show);
  }, []);
  const [invite, setInvite] = useState("");
  const [code, setCode] = useState("");
  const tasks = useMemo(() => [...snap.tasks].reverse().filter((task) => !task.pipelineId || !snap.tasks.some((parent) => parent.id === task.pipelineId)), [snap.tasks]);
  const matchesFilter = (task: Task, value: typeof filter) => value === "all" || (value === "results" ? ["done", "canceled"].includes(task.status) : value === "attention" ? ["blocked", "dispute", "failed"].includes(task.status) || Boolean(task.designPending?.length) : !["done", "canceled"].includes(task.status));
  const visibleTasks = tasks.filter(task => matchesFilter(task, filter));
  const filterLabels = { active: "未完成", attention: "需处理", results: "已结束", all: "全部" };
  const filterHints = { active: "等待认领、执行、评审或测试的任务", attention: "等待方案、遇到阻塞、失败或需要你裁定的任务", results: "已完成或已取消的任务", all: "本频道的全部任务，包括历史记录" };

  return (
    <>
      <section>
        <h2>任务与结果</h2>
        {!snap.room.direct && !snap.room.archived ? <CoordinatorPanel key={snap.room.id} roomId={snap.room.id} onChanged={onChanged} onError={onError} /> : null}
        {tasks.length > 0 ? <>
        <div className="task-filters" role="group" aria-label="筛选任务">
          {(["active", "attention", "results", "all"] as const).map(value => <button type="button" key={value} data-testid={`task-filter-${value}`} title={filterHints[value]} aria-pressed={filter === value} onClick={() => setFilter(value)}>{filterLabels[value]}（{tasks.filter(task => matchesFilter(task, value)).length}）</button>)}
        </div>
        <p className="fine" role="status">{filterHints[filter]} · {visibleTasks.length} 项</p>
        </> : <div className="task-empty"><p className="fine">还没有任务。聊天和提问直接发消息；需要客户端执行工作时，勾选「创建任务」。</p><button type="button" className="text-button" onClick={() => window.dispatchEvent(new CustomEvent("compose-task"))}>创建任务</button></div>}
        <div data-testid="task-list">
          {tasks.length > 0 && visibleTasks.length === 0 ? <p className="fine">没有{filterLabels[filter]}的任务。<button type="button" className="text-button" onClick={() => setFilter("all")}>查看全部任务</button></p> : null}
          {visibleTasks.map((task) => (
            <TaskCard key={task.id} reveal={focused.id === task.id || snap.tasks.some((child) => child.id === focused.id && child.pipelineId === task.id) ? focused.version : 0} focusId={focused.id} task={task} all={snap.tasks} agents={snap.members.agents} onChanged={onChanged} onError={onError} />
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
      <details className="setup-panel">
        <summary>成员管理与客户端接入</summary>
      <LocalAgents
        roomId={snap.room.id}
        joined={snap.members.agents.map((agent) => agent.handle).join("\n")}
        onChanged={onChanged}
        onError={onError}
      />
      <div className="client-management" data-testid="client-management">
        <p className="fine">启用允许客户端参与频道，不会启动 Desktop 会话。最近活动只是工具调用记录，不代表持续监听或正在执行任务。</p>
        <ul className="roster management-roster">
          {snap.members.agents.filter(agent => !agent.demo).map(agent => (
            <li key={agent.id} className="with-level" data-testid={`manage-${agent.handle}`}>
              <i className={agent.online && !agent.paused ? "dot on" : "dot"} aria-hidden="true" />
              <div className="managed-client">
                <strong>{agent.handle}</strong>
                <em>{agent.ownerName} · {agent.runtime}</em>
                <em>{agent.paused ? "已停用" : agent.online ? "已启用 · 最近有客户端活动" : "已启用 · 未检测到最近活动"}</em>
                <em>{groupLabel(agent.tags) || "未分配身份"}</em>
              </div>
              <button type="button" className="text-button" aria-label={`私聊 ${agent.handle}`} onClick={() => void onDirect(agent.handle)}>打开私聊</button>
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
                          {agent.paused ? "启用" : "停用"}
                        </button>
                        <details className="agent-settings"><summary>设置</summary>
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
                        <IdentitySettings agent={agent} onChanged={onChanged} onError={onError} />
                        </details>
            </li>
          ))}
        </ul>
        {snap.members.agents.every(agent => agent.demo) ? <p className="fine">尚未接入真实客户端。</p> : null}
      </div>
      </details>
      <section>
        <div className="section-row">
          <h2>已激活的客户端</h2>
        </div>
        <p className="fine">按身份显示你已启用的客户端。点击名字在频道中 @ 点名。</p>

        <div className="human-members">成员：{snap.members.users.map((user) => user.name).join("、")}</div>
        <ul className="roster" data-testid="roster">
          {rosterGroups(snap).map((group) => (
            <li key={group.key} className="person" data-testid={`role-group-${group.key}`}>
              <details className="role-fold" open={!collapsedGroups[`${snap.room.id}:${group.key}`]}>
              <summary className="person-head" data-testid={`role-toggle-${group.key}`} onClick={(event) => {
                event.preventDefault();
                const key = `${snap.room.id}:${group.key}`;
                setCollapsedGroups(current => {
                  const next = { ...current, [key]: !current[key] };
                  try { localStorage.setItem("chatroom-role-folds", JSON.stringify(next)); } catch {}
                  return next;
                });
              }}>
                <strong>{group.name}</strong>
                <em>{group.agents.length} 个客户端</em>
              </summary>
              {group.agents.length > 0 ? (
                <ul className="person-agents">
                  {group.agents.map((agent) => {
                    const primary = (groupsOf(agent.tags)[0]?.id ?? "unassigned") === group.key;
                    return (
                      <li key={agent.id} className="with-level">
                        <button
                          type="button"
                          className="handle"
                          data-testid={`roster-${agent.handle}${primary ? "" : `-${group.key}`}`}
                          aria-label={`${agent.handle}，${group.name}身份`}
                          onClick={() => onMention(agent.handle)}
                        >
                          <strong>{agent.handle}</strong>
                          <em>{agent.ownerName} · {agent.runtime}</em>
                          {dutyParts(agent.id, snap.tasks).length > 0 ? <em className="agent-duty">{dutyParts(agent.id, snap.tasks).join("、")}</em> : null}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              ) : <p className="fine role-empty">此身份暂无激活的客户端</p>}
              </details>
            </li>
          ))}
        </ul>
        <p className="fine">身份、等级、启停与活动状态在成员管理中查看和修改。</p>
      </section>
      <details className="invite-block setup-panel">
        <summary>邀请成员与手动接入</summary>
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
      </details>

    </>
  );
}

function TaskCard({
  task,
  all = [],
  agents,
  onChanged,
  onError,
  nested = false,
  winning = false,
  reveal = 0,
  focusId = "",
}: {
  task: Task;
  all?: Task[];
  agents: Agent[];
  onChanged: () => void;
  onError: (message: string) => void;
  nested?: boolean;
  winning?: boolean;
  reveal?: number;
  focusId?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false);
  const run = async (action: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    try { await action(); onChanged(); } catch (reason) { onError(reason instanceof Error ? reason.message : "操作失败"); } finally { setBusy(false); }
  };
  const cardRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const show = (event: Event) => { if ((event as CustomEvent<string>).detail === task.id) { setExpanded(true); setTimeout(() => cardRef.current?.scrollIntoView({ block: "nearest" }), 0); } };
    window.addEventListener("show-task", show);
    return () => window.removeEventListener("show-task", show);
  }, [task.id]);
  useEffect(() => { if (reveal) { setExpanded(true); setTimeout(() => cardRef.current?.scrollIntoView({ block: "nearest" }), 0); } }, [reveal]);
  const current = stepIndex(task.status);
  const closed = task.status === "done" || task.status === "canceled";
  const lanes = task.lanes ?? [];
  const parent = isPipelineParent(task);
  const step = isPipelineStep(task);
  const siblings = step ? stepsOf(task.pipelineId!, all) : [];
  const overview = parent ? pipelineOverview(task, stepsOf(task.id, all)) : null;
  const showFlow = lanes.length === 0 && !parent && !step;
  const label = step ? stepStatus(task) : parent ? (PIPELINE_STATUS[task.status] ?? task.status) : (STATUS_LABEL[task.status] ?? task.status);
  return (
    <article ref={cardRef} data-testid={`task-${task.id}`} className={`task status-${task.status}${nested ? " lane" : ""}${winning ? " winner" : ""}${parent ? " pipeline" : ""}${step ? " pipeline-step" : ""}`}>
      <header>
        <h3>{task.title}</h3>
        <span className="pill">{task.designPending?.length ? "出方案" : label}</span>
      </header>
      <p className="task-owner">{task.claims.filter((claim) => !claim.state || claim.state === "active" || claim.state === "completed").map((claim) => `${ROLE_DUTY[claim.role] ?? claim.role}：${claim.handle}${claim.state === "completed" ? "（已完成）" : ""}`).join(" · ") || "尚无 Agent 认领"}</p>
      {task.deliverableRef ? <p className="note">结果：<code>{task.deliverableRef}</code></p> : null}
      <button type="button" className="text-button task-detail-toggle" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{expanded ? "收起详情" : "查看详情与操作"}</button>
      {expanded ? <div className="task-detail">
      <FoldedBody body={task.body} known={new Set(agents.map((agent) => agent.handle))} fold={task.body.length > 500} />
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
          {task.deliverableSummary ? <><span> 交付时说明：</span><FoldedNote text={task.deliverableSummary} /></> : null}
        </p>
      ) : null}
      {task.status === "done" ? <p className="note" data-testid="completed-checks">当前状态：完成。验收记录见下方；交付时说明保留原文。</p> : null}
      {task.deliverableBody ? <section className="task-evidence" data-testid="delivery-report">
        <h4>执行报告</h4>
        <FoldedBody body={task.deliverableBody} known={new Set(agents.map((agent) => agent.handle))} fold={task.deliverableBody.length > 800} />
      </section> : null}
      {task.evidence?.length ? <section className="task-evidence" data-testid="check-evidence">
        <h4>评审与测试记录</h4>
        {task.evidence.map((entry) => <article key={entry.id}>
          <strong>{entry.kind === "review" ? "评审" : "测试"} · {entry.handle}</strong> <time>{timeLabel(entry.createdAt)}</time>
          <FoldedBody body={entry.body} known={new Set(agents.map((agent) => agent.handle))} fold={entry.body.length > 800} />
        </article>)}
      </section> : null}
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
      {overview ? (
        <div className="pipeline-flow" data-testid="pipeline-overview">
          <p className="note pipeline-where" data-testid="pipeline-where">{overview.where}</p>
          <ol className="pipeline-steps">
            {overview.rows.map((row) => (
              <li key={row.id} className={row.state} data-testid={`pipeline-step-${row.role}`}>
                <span className="role">{row.label}</span>
                <strong className={row.owner === "空" ? "vacant" : "held"}>{row.owner}</strong>
                <em>{row.status}</em>
              </li>
            ))}
          </ol>
        </div>
      ) : null}
      {parent ? stepsOf(task.id, all).map((child) => <TaskCard key={child.id} reveal={child.id === focusId ? reveal : 0} task={child} all={all} agents={agents} nested onChanged={onChanged} onError={onError} />) : null}
      {step ? (
        <ul className="slots pipeline-slots" data-testid="pipeline-slots">
          {stepSlots(task, siblings).map((slot) => (
            <li key={slot.label}>
              <span>{slot.label}</span>
              <strong className={slot.held ? "held" : "vacant"}>{slot.value}</strong>
            </li>
          ))}
        </ul>
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
        <fieldset className="task-actions" disabled={busy}>
          {task.claims
            .filter((claim) => claim.role === "implementer")
            .map((claim) => (
              <button
                key={claim.agentId}
                type="button"
                className="danger"
                data-testid={`stop-task-${claim.handle}`}
                onClick={() => void run(() => api.stop(claim.agentId))}
              >
                停止 {claim.handle}
              </button>
            ))}
          {task.designPending?.length ? (
            <button
              type="button"
              data-testid={`handoff-${task.id}`}
              onClick={() => void run(() => api.handoff(task.id))}
            >
              交给实现
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => void run(() => api.done(task.id))}
          >
            标记完成
          </button>
          <button
            type="button"
            className="ghost"
            onClick={() => void run(() => api.cancel(task.id))}
          >
            取消任务
          </button>
        </fieldset>
      )}
      </div> : null}
    </article>
  );
}

function FoldedNote({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const { head, long } = foldBody(text);
  return (
    <>
      {" "}
      {open || !long ? text : head}
      {long ? (
        <button type="button" className="text-button fold-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? "收起" : "展开"}
        </button>
      ) : null}
    </>
  );
}

function Plus() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M8 2.5v11M2.5 8h11" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}
