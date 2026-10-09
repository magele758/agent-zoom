import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, type Me, type Snapshot, type Task } from "./api";

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
  const scroller = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  const stick = useRef(true);

  useEffect(() => {
    const onMention = (event: Event) => {
      const handle = (event as CustomEvent<string>).detail;
      setBody((current) => `${current}${current && !current.endsWith(" ") ? " " : ""}@${handle} `);
      box.current?.focus();
    };
    window.addEventListener("mention", onMention);
    return () => window.removeEventListener("mention", onMention);
  }, []);

  useEffect(() => {
    if (stick.current && scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight;
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
              <p>{message.body}</p>
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
              placeholder="标签，用逗号分开。不填则所有空闲 agent 都能做"
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
        <textarea
          id="composer"
          data-testid="composer"
          ref={box}
          rows={3}
          value={body}
          placeholder={
            snap?.room.direct
              ? "只有这段私聊里的人能看到。先问对方在做什么，避免重复开工。"
              : kind === "instruction"
                ? "写下要做完的需求。匹配的空闲 agent 会认领或投标。"
                : "写给房间。用 @句柄 才会叫醒那个 agent。"
          }
          onChange={(event) => setBody(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }
          }}
        />
        <div className="composer-bar">
          <span>Enter 发送，Shift+Enter 换行</span>
          <button data-testid="send" type="submit" disabled={pending || !body.trim()}>发送</button>
        </div>
      </form>
      )}
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
          {snap.members.users.map((user) => (
            <li key={user.id}>
              <i className={user.online ? "dot on" : "dot"} aria-hidden="true" />
              <span>{user.name}</span>
              <em>人</em>
            </li>
          ))}
          {snap.members.agents.map((agent) => (
            <li key={agent.id} className="with-level">
              <i className={agent.online ? "dot on" : "dot"} aria-hidden="true" />
              <button type="button" className="handle" onClick={() => onMention(agent.handle)}>
                {agent.ownerName} / {agent.handle}
              </button>
              <em title={[agent.machine, agent.cwd].filter(Boolean).join(" · ") || undefined}>
                {agent.demo ? "演示" : agent.runtime}
                {agent.tags ? ` · ${agent.tags}` : ""}
                {agent.machine ? ` · ${agent.machine}` : ""}
                {agent.cwd ? ` · ${agent.cwd}` : ""}
              </em>
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
            </li>
          ))}
        </ul>
        <p className="fine">点句柄会把 @句柄 放进输入框。房间历史成员都能读。复杂任务优先叫醒等级 3 及以上；点名不受等级限制。</p>
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
            <span>npm run enroll -- --code {code} --handle my-codex --runtime codex --tags build --level 1 --cwd /你的/项目</span>
          </p>
        ) : null}
      </section>
      <section>
        <h2>任务</h2>
        <div data-testid="task-list">
          {tasks.length === 0 ? <p className="fine">还没有指令。</p> : null}
          {tasks.map((task) => (
            <TaskCard key={task.id} task={task} onChanged={onChanged} onError={onError} />
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
  onChanged,
  onError,
  nested = false,
  winning = false,
}: {
  task: Task;
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
        <span className="pill">{STATUS_LABEL[task.status] ?? task.status}</span>
      </header>
      {task.acceptance && task.acceptance !== task.body ? <p className="note">验收：{task.acceptance}</p> : null}
      {task.tags ? <p className="note">标签：{task.tags}</p> : null}
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
            const claim = task.claims.find((item) => item.role === role);
            const label = role === "implementer" ? "实现" : role === "reviewer" ? "评审" : "测试";
            return (
              <li key={role}>
                <span>{label}</span>
                <strong className={claim ? "held" : "vacant"}>{claim ? claim.handle : "空"}</strong>
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
