import { MessageDelegate } from "./Delegation";
import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import type { CompanyIndex } from "../../src/company-types";
import type {
  HomeChatBot,
  HomeChatLink,
  HomeChatMessage,
  HomeChatOverview,
  HomeChatRoom,
  HomeChatRoomDetail,
  HomeRoomBinding,
  HomeRoomPost,
  HomeRoomTarget,
} from "../../src/home-room-types";
import type { ZoomMessage } from "../../src/zoom-types";
import { extractIdeaId, LinkedText } from "./InternalLinks";
import { api, request } from "./api";
import { decisionTarget } from "./zoom-routes";
import { messageText } from "./zoom-view";
import "./home-room.css";

type IdeaCitation = {
  id: string;
  title: string;
  body: string;
  sources: { reference: string; body: string }[];
};

const legacyBase = "/api/opc/home-rooms";
const chatBase = "/api/opc/home-chat";
const label = (e: unknown) => (e instanceof Error ? e.message : "无法读取群聊");
const submit = (data: object) => ({ method: "POST", body: JSON.stringify(data) });
const legacyAddress = (id: string) => legacyBase + "/" + encodeURIComponent(id);
type LegacyIndex = { bindings: HomeRoomBinding[]; localRooms: { id: string; name: string; project: string }[] };
type LegacyDirectory = { rooms: HomeRoomTarget[]; bots: { id: string; name: string }[] };
const receipts = {
  sending: "正在送达",
  unknown: "回执待核对",
  retryable: "核对后未找到原帖",
  received: "已送达原房间",
};
const replyModeLabels: Record<string, string> = {
  coordinator: "主控协调",
  "all-members": "全员参与",
  "task-collaboration": "任务协作",
};

function formatTime(iso: string) {
  return new Date(iso).toLocaleString("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
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

function formatPendingShare(item: ZoomMessage) {
  const info = messageText(item);
  const target = decisionTarget(item);
  return [
    `请一起看这项待决事项：${info.title}`,
    `来源：${item.source}${item.folder ? " · " + item.folder : ""}`,
    info.body && info.body !== info.title ? `说明：${info.body.slice(0, 260)}` : "",
    `直达处理：${target}`,
  ]
    .filter(Boolean)
    .join("\n");
}

function scopeLabel(scopeKey: string) {
  if (scopeKey === "default") return "默认提醒群";
  if (scopeKey.startsWith("project:")) return "项目 · " + scopeKey.slice("project:".length);
  if (scopeKey.startsWith("product:")) return "产品 · " + scopeKey.slice("product:".length);
  if (scopeKey.startsWith("line:")) return "业务线 · " + scopeKey.slice("line:".length);
  return scopeKey;
}

function stageLinkForLegacyPost(binding: HomeRoomBinding, post: HomeRoomPost) {
  const ideaId = extractIdeaId(post.body);
  const query = new URLSearchParams({
    step: ideaId ? "idea" : "research",
    refBinding: binding.id,
    refPost: post.id,
  });
  if (ideaId) query.set("item", ideaId);
  return "#stage?" + query;
}

function stageLinkForChatMessage(room: HomeChatRoom, msg: HomeChatMessage) {
  const ideaId = extractIdeaId(msg.text);
  const query = new URLSearchParams({ step: ideaId ? "idea" : "development" });
  if (ideaId) query.set("item", ideaId);
  return "#stage?" + query;
}

function CreateRoomForm({
  bots,
  defaultScope,
  onCreated,
  onCancel,
}: {
  bots: HomeChatBot[];
  defaultScope?: string;
  onCreated: (room: HomeChatRoom, links: HomeChatLink[]) => void;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState("");
  const [selectedBots, setSelectedBots] = useState<string[]>(() => (bots[0] ? [bots[0].id] : []));
  const [hostBotId, setHostBotId] = useState(() => bots[0]?.id ?? "");
  const [replyMode, setReplyMode] = useState<"coordinator" | "all-members">("coordinator");
  const [asDefault, setAsDefault] = useState(false);
  const [bindScope, setBindScope] = useState(defaultScope ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const toggleBot = (id: string) => {
    setSelectedBots((prev) => {
      const next = prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id];
      if (next.length && !next.includes(hostBotId)) setHostBotId(next[0]);
      return next;
    });
  };

  const create = async (e: FormEvent) => {
    e.preventDefault();
    if (busy || !title.trim() || !selectedBots.length) return;
    setBusy(true);
    setError("");
    try {
      const scopeKey = asDefault ? "default" : bindScope.trim() || undefined;
      const result = await request<{ room: HomeChatRoom; links: HomeChatLink[] }>(chatBase + "/rooms", {
        method: "POST",
        body: JSON.stringify({
          title: title.trim(),
          botIds: selectedBots,
          ...(selectedBots.includes(hostBotId) ? { hostBotId } : {}),
          replyMode,
          ...(scopeKey ? { scopeKey } : {}),
        }),
      });
      onCreated(result.room, result.links);
    } catch (err) {
      setError(label(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="hr-create" onSubmit={(e) => void create(e)}>
      <header>
        <h2>新建 Agent Home 群聊</h2>
        <button type="button" onClick={onCancel} disabled={busy}>
          取消
        </button>
      </header>
      <label>
        群聊名称
        <input
          required
          maxLength={120}
          placeholder="例如：OPC 总控群 / PageLens 产研群"
          value={title}
          disabled={busy}
          onChange={(e) => setTitle(e.target.value)}
        />
      </label>
      <fieldset className="hr-bot-picker">
        <legend>选择加入群聊的 Bot（至少 1 位）</legend>
        {bots.length ? (
          <div className="hr-bot-grid">
            {bots.map((bot) => (
              <label key={bot.id} className="hr-bot-check">
                <input
                  type="checkbox"
                  checked={selectedBots.includes(bot.id)}
                  disabled={busy}
                  onChange={() => toggleBot(bot.id)}
                />
                <span>{bot.name}</span>
              </label>
            ))}
          </div>
        ) : (
          <p className="hr-muted">Agent Home 中暂无可用 Bot，请先在 Agent Home 创建并启用 Bot。</p>
        )}
      </fieldset>
      <div className="hr-create-row">
        <label>
          回复模式
          <select
            value={replyMode}
            disabled={busy}
            onChange={(e) => setReplyMode(e.target.value as "coordinator" | "all-members")}
          >
            <option value="coordinator">主控协调（由主控 Bot 统筹分工）</option>
            <option value="all-members">全员参与（@ 指定 Bot 或全员讨论）</option>
          </select>
        </label>
        {selectedBots.length > 0 && (
          <label>
            主控 Bot
            <select value={hostBotId} disabled={busy} onChange={(e) => setHostBotId(e.target.value)}>
              {bots
                .filter((b) => selectedBots.includes(b.id))
                .map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
            </select>
          </label>
        )}
      </div>
      <div className="hr-create-row">
        <label className="hr-check-inline">
          <input
            type="checkbox"
            checked={asDefault}
            disabled={busy}
            onChange={(e) => setAsDefault(e.target.checked)}
          />
          设为 OPC 默认待决提醒群（工作流/实验/能力审批自动推到此群）
        </label>
        {!asDefault && (
          <label>
            或绑定项目/业务线范围（选填）
            <input
              placeholder="例如 project:产品/项目 或 line:shop"
              value={bindScope}
              disabled={busy}
              onChange={(e) => setBindScope(e.target.value)}
            />
          </label>
        )}
      </div>
      <div className="hr-create-actions">
        <button type="submit" className="hr-primary" disabled={busy || !title.trim() || !selectedBots.length}>
          {busy ? "正在创建…" : "创建并进入群聊"}
        </button>
      </div>
      {error && <p role="alert">{error}</p>}
    </form>
  );
}

function DirectChatPanel({
  room,
  bots,
  links,
  pending,
  ideaCitation,
  draftText,
  onClearIdea,
  onClearDraft,
  onRoomUpdated,
  onLinksUpdated,
}: {
  room: HomeChatRoom;
  bots: HomeChatBot[];
  links: HomeChatLink[];
  pending: ZoomMessage[];
  ideaCitation: IdeaCitation | null;
  draftText: string;
  onClearIdea: () => void;
  onClearDraft: () => void;
  onRoomUpdated: (room: HomeChatRoom) => void;
  onLinksUpdated: (links: HomeChatLink[]) => void;
}) {
  const [detail, setDetail] = useState<HomeChatRoomDetail | null>(null);
  const [older, setOlder] = useState<HomeChatMessage[]>([]);
  const [body, setBody] = useState("");
  const [mentions, setMentions] = useState<string[]>([]);
  const [replyTo, setReplyTo] = useState<HomeChatMessage | null>(null);
  const [addingBot, setAddingBot] = useState("");
  const [scopeInput, setScopeInput] = useState("");
  const [showSettings, setShowSettings] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [reload, setReload] = useState(0);
  const appliedIdea = useRef("");
  const appliedDraft = useRef("");
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setOlder([]);
    setReplyTo(null);
    setMentions([]);
    setError("");
    setNotice("");
  }, [room.id]);

  useEffect(() => {
    if (!ideaCitation || appliedIdea.current === ideaCitation.id) return;
    appliedIdea.current = ideaCitation.id;
    setBody((current) => (current.trim() ? current : formatIdeaPrompt(ideaCitation)));
  }, [ideaCitation]);

  useEffect(() => {
    if (!draftText || appliedDraft.current === draftText) return;
    appliedDraft.current = draftText;
    setBody((current) => (current.trim() ? current : draftText));
  }, [draftText]);

  useEffect(() => {
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      if (!document.hidden) {
        try {
          const next = await request<HomeChatRoomDetail>(
            chatBase + "/rooms/" + encodeURIComponent(room.id) + "/messages?limit=80",
            { signal: abort.signal },
          );
          if (!abort.signal.aborted) {
            setDetail(next);
            onRoomUpdated(next.room);
          }
        } catch (err) {
          if (!abort.signal.aborted) setError(label(err));
        }
      }
      if (!abort.signal.aborted) timer = setTimeout(poll, 2500);
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
  }, [room.id, reload]);

  const activeRoom = detail?.room ?? room;
  const allBots = detail?.bots.length ? detail.bots : bots;
  const botById = useMemo(() => new Map(allBots.map((b) => [b.id, b])), [allBots]);
  const memberBots = activeRoom.botIds.map((id) => botById.get(id) ?? { id, name: id });
  const joinableBots = allBots.filter((b) => !activeRoom.botIds.includes(b.id));
  const roomLinks = links.filter((l) => l.remoteRoom === activeRoom.id);
  const isDefaultRoom = roomLinks.some((l) => l.scopeKey === "default");
  const mergedMessages = useMemo(() => {
    const map = new Map<string, HomeChatMessage>();
    for (const m of older) map.set(m.id, m);
    for (const m of detail?.messages ?? []) map.set(m.id, m);
    return [...map.values()].sort((a, b) => a.seq - b.seq);
  }, [older, detail?.messages]);
  const runningTurn = detail?.turns.some((t) => t.status === "running" || t.status === "queued");

  const runAction = async (work: () => Promise<void>, successNote = "") => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await work();
      if (successNote) setNotice(successNote);
      setReload((n) => n + 1);
    } catch (err) {
      setError(label(err));
    } finally {
      setBusy(false);
    }
  };

  const loadEarlier = async () => {
    const cursor = older[0]?.seq ?? detail?.nextCursor;
    if (!cursor || busy) return;
    setBusy(true);
    setError("");
    try {
      const page = await request<HomeChatRoomDetail>(
        chatBase + "/rooms/" + encodeURIComponent(activeRoom.id) + "/messages?limit=80&beforeSeq=" + cursor,
      );
      setOlder((prev) => [...page.messages, ...prev]);
    } catch (err) {
      setError(label(err));
    } finally {
      setBusy(false);
    }
  };

  const sendText = async (textToSend: string, extra: { mentions?: string[]; reply?: HomeChatMessage | null } = {}) => {
    const clean = textToSend.trim();
    if (!clean) return;
    await runAction(async () => {
      await request(chatBase + "/rooms/" + encodeURIComponent(activeRoom.id) + "/messages", {
        method: "POST",
        body: JSON.stringify({
          text: clean,
          ...(extra.mentions?.length ? { mentions: extra.mentions } : {}),
          ...(extra.reply
            ? {
                replyTo: {
                  messageId: extra.reply.id,
                  ...(extra.reply.sender.type === "bot" ? { botId: extra.reply.sender.id } : {}),
                  excerpt: extra.reply.text.replace(/\s+/g, " ").trim().slice(0, 120),
                },
              }
            : {}),
          ...(ideaCitation ? { ideaId: ideaCitation.id } : {}),
        }),
      });
    });
    setTimeout(() => endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" }), 80);
  };

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy || !body.trim()) return;
    const text = body;
    const picked = mentions;
    const targetReply = replyTo;
    setBody("");
    setReplyTo(null);
    setMentions([]);
    if (ideaCitation) onClearIdea();
    if (draftText) onClearDraft();
    await sendText(text, { mentions: picked, reply: targetReply });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      if (!busy && body.trim()) void onSubmit(e as unknown as FormEvent);
    }
  };

  const toggleDefaultLink = () =>
    void runAction(async () => {
      if (isDefaultRoom) {
        const res = await request<{ links: HomeChatLink[] }>(chatBase + "/links?scopeKey=default", {
          method: "DELETE",
        });
        onLinksUpdated(res.links);
      } else {
        const res = await request<{ links: HomeChatLink[] }>(chatBase + "/links", {
          method: "PUT",
          body: JSON.stringify({ scopeKey: "default", remoteRoom: activeRoom.id, roomTitle: activeRoom.title }),
        });
        onLinksUpdated(res.links);
      }
    }, isDefaultRoom ? "已取消默认提醒群" : "已设为默认提醒群，待决审批将同步提醒到此群");

  const bindCustomScope = (e: FormEvent) => {
    e.preventDefault();
    const key = scopeInput.trim();
    if (!key) return;
    void runAction(async () => {
      const res = await request<{ links: HomeChatLink[] }>(chatBase + "/links", {
        method: "PUT",
        body: JSON.stringify({ scopeKey: key, remoteRoom: activeRoom.id, roomTitle: activeRoom.title }),
      });
      onLinksUpdated(res.links);
      setScopeInput("");
    }, `已将「${scopeLabel(key)}」的待决提醒绑定到本群`);
  };

  const removeLink = (scopeKey: string) =>
    void runAction(async () => {
      const res = await request<{ links: HomeChatLink[] }>(
        chatBase + "/links?" + new URLSearchParams({ scopeKey }),
        { method: "DELETE" },
      );
      onLinksUpdated(res.links);
    });

  return (
    <article className="hr-chat-panel" aria-label={"群聊 " + activeRoom.title}>
      <header className="hr-chat-head">
        <div>
          <div className="hr-chat-title-row">
            <h2>{activeRoom.title}</h2>
            <span className="hr-badge" data-tone={activeRoom.status === "active" ? "ok" : "warn"}>
              {activeRoom.status === "active" ? "进行中" : "已暂停"}
            </span>
            {activeRoom.replyMode && (
              <span className="hr-badge">{replyModeLabels[activeRoom.replyMode] ?? activeRoom.replyMode}</span>
            )}
            {roomLinks.map((item) => (
              <span key={item.scopeKey} className="hr-badge" data-tone="accent">
                {scopeLabel(item.scopeKey)}
              </span>
            ))}
          </div>
          <div className="hr-members" aria-label="群成员">
            {memberBots.map((bot) => (
              <span key={bot.id} className="hr-member-chip">
                @{bot.name}
                {activeRoom.hostBotId === bot.id && <em>主控</em>}
                {memberBots.length > 1 && showSettings && (
                  <button
                    type="button"
                    aria-label={"移出 " + bot.name}
                    disabled={busy}
                    onClick={() =>
                      void runAction(async () => {
                        const res = await request<{ room: HomeChatRoom }>(
                          chatBase +
                            "/rooms/" +
                            encodeURIComponent(activeRoom.id) +
                            "/members/" +
                            encodeURIComponent(bot.id),
                          { method: "DELETE" },
                        );
                        onRoomUpdated(res.room);
                      })
                    }
                  >
                    ×
                  </button>
                )}
              </span>
            ))}
          </div>
        </div>
        <div className="hr-chat-controls">
          <button type="button" disabled={busy} onClick={toggleDefaultLink}>
            {isDefaultRoom ? "取消默认提醒群" : "设为默认提醒群"}
          </button>
          <button type="button" onClick={() => setShowSettings((v) => !v)}>
            {showSettings ? "收起设置" : "群设置"}
          </button>
          {activeRoom.status === "active" ? (
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                void runAction(async () => {
                  const res = await request<{ room: HomeChatRoom }>(
                    chatBase + "/rooms/" + encodeURIComponent(activeRoom.id) + "/stop",
                    submit({}),
                  );
                  onRoomUpdated(res.room);
                }, "已暂停本群回复")
              }
            >
              暂停
            </button>
          ) : (
            <button
              type="button"
              className="hr-primary"
              disabled={busy}
              onClick={() =>
                void runAction(async () => {
                  const res = await request<{ room: HomeChatRoom }>(
                    chatBase + "/rooms/" + encodeURIComponent(activeRoom.id) + "/resume",
                    submit({}),
                  );
                  onRoomUpdated(res.room);
                }, "已恢复本群对话")
              }
            >
              恢复
            </button>
          )}
        </div>
      </header>

      {showSettings && (
        <section className="hr-settings" aria-label="群聊设置">
          <div className="hr-settings-row">
            <label>
              回复模式
              <select
                value={activeRoom.replyMode ?? "coordinator"}
                disabled={busy}
                onChange={(e) =>
                  void runAction(async () => {
                    const res = await request<{ room: HomeChatRoom; links: HomeChatLink[] }>(
                      chatBase + "/rooms/" + encodeURIComponent(activeRoom.id),
                      { method: "PATCH", body: JSON.stringify({ replyMode: e.target.value }) },
                    );
                    onRoomUpdated(res.room);
                    onLinksUpdated(res.links);
                  })
                }
              >
                <option value="coordinator">主控协调</option>
                <option value="all-members">全员参与</option>
              </select>
            </label>
            {joinableBots.length > 0 && (
              <div className="hr-add-member">
                <label>
                  拉新 Bot 进群
                  <select value={addingBot} disabled={busy} onChange={(e) => setAddingBot(e.target.value)}>
                    <option value="">选择 Bot</option>
                    {joinableBots.map((b) => (
                      <option key={b.id} value={b.id}>
                        {b.name}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  type="button"
                  disabled={busy || !addingBot}
                  onClick={() =>
                    void runAction(async () => {
                      const res = await request<{ room: HomeChatRoom }>(
                        chatBase + "/rooms/" + encodeURIComponent(activeRoom.id) + "/members",
                        submit({ botId: addingBot }),
                      );
                      onRoomUpdated(res.room);
                      setAddingBot("");
                    })
                  }
                >
                  加入群聊
                </button>
              </div>
            )}
          </div>
          <form className="hr-scope-form" onSubmit={bindCustomScope}>
            <label>
              按项目或业务线自动提醒到此群
              <input
                value={scopeInput}
                disabled={busy}
                placeholder="project:产品/项目 或 product:产品名 或 line:shop"
                onChange={(e) => setScopeInput(e.target.value)}
              />
            </label>
            <button type="submit" disabled={busy || !scopeInput.trim()}>
              添加绑定
            </button>
          </form>
          {roomLinks.length > 0 && (
            <div className="hr-bound-scopes">
              {roomLinks.map((item) => (
                <span key={item.scopeKey} className="hr-member-chip">
                  {scopeLabel(item.scopeKey)}
                  <button
                    type="button"
                    aria-label={"解除 " + item.scopeKey}
                    disabled={busy}
                    onClick={() => removeLink(item.scopeKey)}
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}
        </section>
      )}

      {pending.length > 0 && (
        <details className="hr-pending-bar">
          <summary>
            待处理的审批与复盘 <b>{pending.length}</b>
            <small>可在原业务页直接拍板，或一键发到本群与 Bot 讨论</small>
          </summary>
          <ul>
            {pending.slice(0, 8).map((item) => (
              <li key={item.id}>
                <div>
                  <a href={decisionTarget(item)}>{messageText(item).title} ↗</a>
                  <small>
                    {item.source}
                    {item.folder ? " · " + item.folder : ""}
                  </small>
                </div>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void sendText(formatPendingShare(item))}
                >
                  发到本群讨论
                </button>
              </li>
            ))}
          </ul>
        </details>
      )}

      {notice && <p role="status" className="hr-status">{notice}</p>}
      {error && <p role="alert" className="hr-error">{error}</p>}

      <div className="hr-stream">
        {detail?.hasMore && (
          <button type="button" className="hr-load-more" disabled={busy} onClick={() => void loadEarlier()}>
            加载更早消息
          </button>
        )}
        <ol className="hr-posts">
          {mergedMessages.map((msg) => {
            const isBot = msg.sender.type === "bot";
            return (
              <li key={msg.id} className={isBot ? "hr-msg-bot" : "hr-msg-user"}>
                <div>
                  <strong>{isBot ? msg.sender.name : "你"}</strong>
                  {isBot && <span className="hr-role-tag">Bot</span>}
                  {msg.mentions && msg.mentions.length > 0 && (
                    <small>
                      @{msg.mentions.map((id) => botById.get(id)?.name ?? id).join(" @")}
                    </small>
                  )}
                  <time dateTime={msg.createdAt}>{formatTime(msg.createdAt)}</time>
                </div>
                {msg.replyTo?.excerpt && <blockquote>{msg.replyTo.excerpt}</blockquote>}
                <p>
                  <LinkedText text={msg.text} />
                </p>
                <div className="hr-post-actions">
                  <button type="button" disabled={busy} onClick={() => setReplyTo(msg)}>
                    回复
                  </button>
                  <a className="hr-stage-link" href={stageLinkForChatMessage(activeRoom, msg)}>
                    转为阶段任务 ↗
                  </a>
                </div>
              </li>
            );
          })}
        </ol>
        {detail && mergedMessages.length === 0 && (
          <p className="hr-muted">这个群聊还没有消息。直接发话或点名下方 Bot 开始协作。</p>
        )}
        {runningTurn && <p role="status" className="hr-thinking">群内 Bot 正在处理回复…</p>}
        <div ref={endRef} />
      </div>

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
              onClearIdea();
              if (body === formatIdeaPrompt(ideaCitation)) setBody("");
            }}
          >
            取消引用
          </button>
        </div>
      )}

      <form className="hr-compose" onSubmit={(e) => void onSubmit(e)}>
        {replyTo && (
          <div className="hr-reply-banner">
            <blockquote>
              回复 {replyTo.sender.type === "bot" ? replyTo.sender.name : "你"}：{replyTo.text.slice(0, 120)}
            </blockquote>
            <button type="button" disabled={busy} onClick={() => setReplyTo(null)}>
              取消
            </button>
          </div>
        )}
        {memberBots.length > 0 && (
          <div className="hr-mention-bar" aria-label="点名群内 Bot">
            <small>点名（不选则按群模式自动响应）：</small>
            {memberBots.map((bot) => {
              const active = mentions.includes(bot.id);
              return (
                <button
                  type="button"
                  key={bot.id}
                  className="hr-mention-pill"
                  aria-pressed={active}
                  disabled={busy}
                  onClick={() =>
                    setMentions((prev) => (prev.includes(bot.id) ? prev.filter((id) => id !== bot.id) : [...prev, bot.id]))
                  }
                >
                  @{bot.name}
                </button>
              );
            })}
          </div>
        )}
        <textarea
          required
          maxLength={16000}
          rows={3}
          value={body}
          disabled={busy || activeRoom.status !== "active"}
          placeholder={
            activeRoom.status !== "active"
              ? "群聊已暂停，点击右上角「恢复」后可继续发言"
              : "在 Agent Home 群聊中发言…（Cmd/Ctrl + Enter 发送）"
          }
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <div className="hr-compose-foot">
          <small>支持多 Bot 群聊、直接续聊，也可点击消息里的直达链接去业务页拍板</small>
          <button
            type="submit"
            className="hr-primary"
            disabled={busy || !body.trim() || activeRoom.status !== "active"}
          >
            {busy ? "发送中…" : "发送到群聊"}
          </button>
        </div>
      </form>
    </article>
  );
}

function LegacyBindRoom({
  localRooms,
  saved,
}: {
  localRooms: LegacyIndex["localRooms"];
  saved: (item: HomeRoomBinding) => void;
}) {
  const [catalog, setCatalog] = useState<LegacyDirectory>();
  const [localRoom, setLocal] = useState("");
  const [remoteRoom, setRemote] = useState("");
  const [botId, setBot] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    const abort = new AbortController();
    request<LegacyDirectory>(legacyBase + "/directory", { signal: abort.signal })
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
      saved(await request<HomeRoomBinding>(legacyBase, submit({ localRoom, remoteRoom, botId })));
    } catch (err) {
      setError(label(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="hr-bind" onSubmit={(e) => void bind(e)}>
      <fieldset disabled={busy}>
        <legend>关联已有频道与单个 Bot（旧版兼容）</legend>
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
      {error && (
        <p role="alert">
          {error}{" "}
          {!catalog && (
            <button type="button" onClick={() => setRefresh((n) => n + 1)}>
              重新读取
            </button>
          )}
        </p>
      )}
    </form>
  );
}

function LegacyDiscussion({
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
  const path = legacyAddress(binding.id);
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
          <span>{binding.project} · 旧版频道绑定</span>
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
                <time dateTime={post.createdAt}>{formatTime(post.createdAt)}</time>
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
                <a className="hr-stage-link" href={stageLinkForLegacyPost(binding, post)}>
                  转为阶段任务 ↗
                </a>
              </div>
            </li>
          );
        })}
      </ol>
      <form className="hr-compose" onSubmit={send}>
        {parent && (
          <div className="hr-reply-banner">
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

export function HomeRoom({
  project = "",
  pending = [],
  nav,
}: {
  project?: string;
  pending?: ZoomMessage[];
  nav?: ReactNode;
}) {
  const params = new URLSearchParams(location.hash.split("?")[1]);
  const roomParam = params.get("room") ?? "";
  const bindingParam = params.get("binding") ?? "";
  const highlightPost = params.get("post") ?? "";
  const ideaParam = params.get("idea") ?? "";
  const draftParam = params.get("draft") ?? "";

  const [overview, setOverview] = useState<HomeChatOverview | null>(null);
  const [legacy, setLegacy] = useState<LegacyIndex | null>(null);
  const [selectedRoomId, setSelectedRoomId] = useState(roomParam);
  const [selectedBindingId, setSelectedBindingId] = useState(bindingParam);
  const [creating, setCreating] = useState(false);
  const [showLegacyBind, setShowLegacyBind] = useState(false);
  const [ideaCitation, setIdeaCitation] = useState<IdeaCitation | null>(null);
  const [draftText, setDraftText] = useState(draftParam);
  const [reload, setReload] = useState(0);
  const [error, setError] = useState("");

  useEffect(() => {
    if (roomParam) {
      setSelectedRoomId(roomParam);
      setSelectedBindingId("");
    } else if (bindingParam) {
      setSelectedBindingId(bindingParam);
    }
  }, [roomParam, bindingParam]);

  useEffect(() => {
    setDraftText(draftParam);
  }, [draftParam]);

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
    setError("");
    Promise.all([
      request<HomeChatOverview>(chatBase + "/overview", { signal: abort.signal }).catch(
        (err): HomeChatOverview => ({
          available: false,
          origin: "http://127.0.0.1:37070",
          reason: label(err),
          rooms: [],
          bots: [],
          links: [],
        }),
      ),
      request<LegacyIndex>(legacyBase, { signal: abort.signal }).catch(() => null),
    ]).then(([chatData, legacyData]) => {
      if (abort.signal.aborted) return;
      setOverview(chatData);
      setLegacy(legacyData);
    });
    return () => abort.abort();
  }, [reload]);

  const resolvedRoom = useMemo(() => {
    if (!overview?.rooms.length || selectedBindingId) return null;
    if (selectedRoomId) {
      const exact = overview.rooms.find((r) => r.id === selectedRoomId);
      if (exact) return exact;
    }
    if (project) {
      const candidates = ["project:" + project, "product:" + project.split("/")[0]];
      const linked = overview.links.find((l) => candidates.includes(l.scopeKey));
      if (linked) {
        const matched = overview.rooms.find((r) => r.id === linked.remoteRoom);
        if (matched) return matched;
      }
    }
    const defaultLink = overview.links.find((l) => l.scopeKey === "default");
    if (defaultLink) {
      const def = overview.rooms.find((r) => r.id === defaultLink.remoteRoom);
      if (def) return def;
    }
    return overview.rooms[0];
  }, [overview, selectedRoomId, selectedBindingId, project]);

  const resolvedBinding = useMemo(() => {
    if (!legacy?.bindings.length) return null;
    if (selectedBindingId) return legacy.bindings.find((b) => b.id === selectedBindingId) ?? null;
    if (!overview?.available && !overview?.rooms.length) return legacy.bindings[0];
    return null;
  }, [legacy, selectedBindingId, overview]);

  const linksByRoom = useMemo(() => {
    const map = new Map<string, HomeChatLink[]>();
    for (const item of overview?.links ?? []) {
      const list = map.get(item.remoteRoom) ?? [];
      list.push(item);
      map.set(item.remoteRoom, list);
    }
    return map;
  }, [overview?.links]);

  return (
    <section className="zo-product hr-page" aria-label="Agent Home 群聊">
      <header className="zo-product-head hr-top-head">
        {nav}
        <div>
          <a href="#overview">全局看板 ↗</a>
          <h1>Agent Home 群聊</h1>
        </div>
        <div className="hr-top-actions">
          {overview?.origin && (
            <a href={overview.origin} target="_blank" rel="noreferrer">
              打开原生 Agent Home ↗
            </a>
          )}
          <button type="button" onClick={() => setReload((n) => n + 1)}>
            刷新群聊
          </button>
          <button
            type="button"
            className="hr-primary"
            disabled={!overview?.available}
            onClick={() => {
              setCreating((v) => !v);
              setSelectedBindingId("");
            }}
          >
            {creating ? "取消新建" : "+ 新建群聊"}
          </button>
        </div>
      </header>

      <div className="hr-shell">
        <aside className="hr-rail" aria-label="群聊列表">
          <div className="hr-rail-head">
            <strong>全部群聊</strong>
            <small>{overview ? overview.rooms.length : "…"}</small>
          </div>
          {!overview && <p className="hr-muted">正在连接 Agent Home…</p>}
          {overview && !overview.available && (
            <div className="hr-offline" role="status">
              <p>{overview.reason || "暂未连接到 Agent Home 服务。"}</p>
              <small>地址：{overview.origin}</small>
              <button type="button" onClick={() => setReload((n) => n + 1)}>
                重新连接
              </button>
            </div>
          )}
          {overview?.available && overview.rooms.length === 0 && (
            <p className="hr-muted">Agent Home 中还没有群聊，点击右上角「+ 新建群聊」即可创建。</p>
          )}
          {overview && overview.rooms.length > 0 && (
            <ul className="hr-room-list">
              {overview.rooms.map((room) => {
                const active = !creating && !resolvedBinding && resolvedRoom?.id === room.id;
                const roomTags = linksByRoom.get(room.id) ?? [];
                return (
                  <li key={room.id}>
                    <button
                      type="button"
                      className="hr-room-item"
                      aria-current={active ? "true" : undefined}
                      onClick={() => {
                        setCreating(false);
                        setSelectedBindingId("");
                        setSelectedRoomId(room.id);
                      }}
                    >
                      <strong>{room.title}</strong>
                      <small>
                        {room.botIds.length} 位 Bot
                        {room.status !== "active" ? " · 已暂停" : ""}
                      </small>
                      {roomTags.length > 0 && (
                        <span className="hr-room-tags">
                          {roomTags.map((t) => scopeLabel(t.scopeKey)).join(" / ")}
                        </span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}

          {legacy && (legacy.bindings.length > 0 || showLegacyBind) && (
            <details className="hr-legacy-section" open={Boolean(resolvedBinding || showLegacyBind)}>
              <summary>
                旧版频道绑定 <small>{legacy.bindings.length}</small>
              </summary>
              <ul className="hr-room-list">
                {legacy.bindings.map((b) => (
                  <li key={b.id}>
                    <button
                      type="button"
                      className="hr-room-item"
                      aria-current={resolvedBinding?.id === b.id ? "true" : undefined}
                      onClick={() => {
                        setCreating(false);
                        setSelectedBindingId(b.id);
                      }}
                    >
                      <strong>{b.roomTitle}</strong>
                      <small>
                        {b.project} · @{b.botName}
                      </small>
                    </button>
                  </li>
                ))}
              </ul>
              <button type="button" className="hr-link-btn" onClick={() => setShowLegacyBind((v) => !v)}>
                {showLegacyBind ? "收起绑定表单" : "关联本地频道与 Bot"}
              </button>
            </details>
          )}
        </aside>

        <div className="hr-main">
          {error && <p role="alert" className="hr-error">{error}</p>}
          {creating && overview ? (
            <CreateRoomForm
              bots={overview.bots}
              defaultScope={project ? "project:" + project : ""}
              onCancel={() => setCreating(false)}
              onCreated={(room, links) => {
                setOverview((prev) =>
                  prev
                    ? { ...prev, rooms: [room, ...prev.rooms.filter((item) => item.id !== room.id)], links }
                    : prev,
                );
                setCreating(false);
                setSelectedRoomId(room.id);
              }}
            />
          ) : showLegacyBind && legacy ? (
            <LegacyBindRoom
              localRooms={legacy.localRooms}
              saved={(item) => {
                setLegacy({
                  ...legacy,
                  bindings: [...legacy.bindings.filter((b) => b.id !== item.id), item],
                });
                setSelectedBindingId(item.id);
                setShowLegacyBind(false);
              }}
            />
          ) : resolvedBinding ? (
            <LegacyDiscussion
              key={resolvedBinding.id}
              binding={resolvedBinding}
              highlightPost={highlightPost}
              ideaCitation={ideaCitation}
              onClearIdea={() => setIdeaCitation(null)}
            />
          ) : resolvedRoom && overview ? (
            <DirectChatPanel
              key={resolvedRoom.id}
              room={resolvedRoom}
              bots={overview.bots}
              links={overview.links}
              pending={pending}
              ideaCitation={ideaCitation}
              draftText={draftText}
              onClearIdea={() => setIdeaCitation(null)}
              onClearDraft={() => setDraftText("")}
              onRoomUpdated={(updated) =>
                setOverview((prev) =>
                  prev
                    ? { ...prev, rooms: prev.rooms.map((item) => (item.id === updated.id ? updated : item)) }
                    : prev,
                )
              }
              onLinksUpdated={(links) => setOverview((prev) => (prev ? { ...prev, links } : prev))}
            />
          ) : (
            <div className="hr-empty-state">
              <h2>用 Agent Home 群聊协作</h2>
              <p>
                在左侧选择一个群聊，或点击「+ 新建群聊」拉起多位 Bot 一起讨论需求、评审方案。设为「默认提醒群」后，工作流审批、经营实验复盘与开源能力变更会自动同步提醒到群里，点击链接直达原页面拍板。
              </p>
              {pending.length > 0 && (
                <section className="hr-pending-fallback" aria-label="当前待处理事项">
                  <h3>当前待处理事项（{pending.length}）</h3>
                  <ul>
                    {pending.map((item) => (
                      <li key={item.id}>
                        <a href={decisionTarget(item)}>{messageText(item).title} ↗</a>
                        <small>{item.source}</small>
                      </li>
                    ))}
                  </ul>
                </section>
              )}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
