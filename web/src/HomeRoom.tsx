import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import type { CompanyIndex } from "../../src/company-types";
import type {
  HomeChatBot,
  HomeChatLink,
  HomeChatOverview,
  HomeChatRoom,
} from "../../src/home-room-types";
import type { ZoomMessage } from "../../src/zoom-types";
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

const chatBase = "/api/opc/home-chat";
const label = (e: unknown) => (e instanceof Error ? e.message : "无法读取 Agent Home 信息");

const replyModeLabels: Record<string, string> = {
  coordinator: "主控协调",
  "all-members": "全员参与",
  "task-collaboration": "任务协作",
};

function botStatusMeta(status?: HomeChatBot["status"]): { label: string; tone: "ok" | "info" | "warn" | "muted" } {
  switch (status) {
    case "running": return { label: "运行中", tone: "info" };
    case "idle": return { label: "在线待命", tone: "ok" };
    case "paused": return { label: "已暂停", tone: "warn" };
    case "disabled": return { label: "已停用", tone: "warn" };
    default: return { label: "可用", tone: "muted" };
  }
}

function scopeLabel(scopeKey: string) {
  if (scopeKey === "default") return "默认提醒群";
  if (scopeKey.startsWith("project:")) return "项目 · " + scopeKey.slice("project:".length);
  if (scopeKey.startsWith("product:")) return "产品 · " + scopeKey.slice("product:".length);
  if (scopeKey.startsWith("line:")) return "业务线 · " + scopeKey.slice("line:".length);
  return scopeKey;
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
        <button type="button" onClick={onCancel} disabled={busy}>取消</button>
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
          <p className="hr-muted">Agent Home 中暂无可用 Bot。</p>
        )}
      </fieldset>
      <div className="hr-create-row">
        <label>
          回复模式
          <select value={replyMode} disabled={busy} onChange={(e) => setReplyMode(e.target.value as "coordinator" | "all-members")}>
            <option value="coordinator">主控协调（由主控 Bot 统筹分工）</option>
            <option value="all-members">全员参与（@ 指定 Bot 或全员讨论）</option>
          </select>
        </label>
        {selectedBots.length > 0 && (
          <label>
            主控 Bot
            <select value={hostBotId} disabled={busy} onChange={(e) => setHostBotId(e.target.value)}>
              {bots.filter((b) => selectedBots.includes(b.id)).map((b) => (
                <option key={b.id} value={b.id}>{b.name}</option>
              ))}
            </select>
          </label>
        )}
      </div>
      <div className="hr-create-row">
        <label className="hr-check-inline">
          <input type="checkbox" checked={asDefault} disabled={busy} onChange={(e) => setAsDefault(e.target.checked)} />
          设为 OPC 默认待决提醒群（审批自动推到此群）
        </label>
        {!asDefault && (
          <label>
            或绑定项目/业务线范围（选填）
            <input placeholder="例如 project:产品/项目 或 line:shop" value={bindScope} disabled={busy} onChange={(e) => setBindScope(e.target.value)} />
          </label>
        )}
      </div>
      <div className="hr-create-actions">
        <button type="submit" className="hr-primary" disabled={busy || !title.trim() || !selectedBots.length}>
          {busy ? "创建中…" : "创建群聊"}
        </button>
        <button type="button" onClick={onCancel} disabled={busy}>取消</button>
      </div>
      {error && <p role="alert" className="hr-error">{error}</p>}
    </form>
  );
}

function RoomDirectoryPanel({
  room,
  origin,
  bots,
  links,
  pending,
  ideaCitation,
  draftText,
  onClearIdea,
  onClearDraft,
  onSelectBot,
  onRoomUpdated,
  onLinksUpdated,
}: {
  room: HomeChatRoom;
  origin: string;
  bots: HomeChatBot[];
  links: HomeChatLink[];
  pending: ZoomMessage[];
  ideaCitation: IdeaCitation | null;
  draftText: string;
  onClearIdea: () => void;
  onClearDraft: () => void;
  onSelectBot: (botId: string) => void;
  onRoomUpdated: (room: HomeChatRoom) => void;
  onLinksUpdated: (links: HomeChatLink[]) => void;
}) {
  const [showSettings, setShowSettings] = useState(false);
  const [editTitle, setEditTitle] = useState(room.title);
  const [editHost, setEditHost] = useState(room.hostBotId ?? room.botIds[0] ?? "");
  const [editMode, setEditMode] = useState<"coordinator" | "all-members">(
    room.replyMode === "all-members" ? "all-members" : "coordinator",
  );
  const [addBotId, setAddBotId] = useState("");
  const [quickBody, setQuickBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    setEditTitle(room.title);
    setEditHost(room.hostBotId ?? room.botIds[0] ?? "");
    setEditMode(room.replyMode === "all-members" ? "all-members" : "coordinator");
    setNotice("");
    setError("");
  }, [room.id, room.title, room.hostBotId, room.replyMode, room.botIds]);

  useEffect(() => {
    if (ideaCitation) setQuickBody(formatIdeaPrompt(ideaCitation));
    else if (draftText) setQuickBody(draftText);
  }, [ideaCitation, draftText]);

  const botMap = useMemo(() => new Map(bots.map((b) => [b.id, b])), [bots]);
  const memberBots = useMemo(
    () => room.botIds.map((id) => botMap.get(id) ?? { id, name: id }),
    [room.botIds, botMap],
  );
  const availableToAdd = useMemo(
    () => bots.filter((b) => !room.botIds.includes(b.id)),
    [bots, room.botIds],
  );
  const roomLinks = useMemo(() => links.filter((l) => l.remoteRoom === room.id), [links, room.id]);
  const isDefault = roomLinks.some((l) => l.scopeKey === "default");
  const isExecutiveRoom = room.title.includes("总裁办") || room.title.includes("Super Bot");

  const runAction = async (fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await fn();
    } catch (err) {
      setError(label(err));
    } finally {
      setBusy(false);
    }
  };

  const toggleDefault = () =>
    runAction(async () => {
      if (isDefault) {
        const res = await request<{ links: HomeChatLink[] }>(chatBase + "/links/default", { method: "DELETE" });
        onLinksUpdated(res.links);
        setNotice("已取消该群的 OPC 默认提醒绑定。");
      } else {
        const res = await request<{ links: HomeChatLink[] }>(chatBase + "/links", {
          method: "PUT",
          body: JSON.stringify({ scopeKey: "default", remoteRoom: room.id, roomTitle: room.title }),
        });
        onLinksUpdated(res.links);
        setNotice("已设为 OPC 默认提醒群。");
      }
    });

  const toggleStatus = () =>
    runAction(async () => {
      const action = room.status === "active" ? "stop" : "resume";
      const res = await request<{ room: HomeChatRoom }>(`${chatBase}/rooms/${encodeURIComponent(room.id)}/${action}`, {
        method: "POST",
        body: JSON.stringify({}),
      });
      onRoomUpdated(res.room);
      setNotice(action === "stop" ? "已暂停该群聊。" : "已恢复该群聊。");
    });

  const saveSettings = (e: FormEvent) => {
    e.preventDefault();
    void runAction(async () => {
      const res = await request<{ room: HomeChatRoom; links: HomeChatLink[] }>(
        `${chatBase}/rooms/${encodeURIComponent(room.id)}`,
        {
          method: "PATCH",
          body: JSON.stringify({
            ...(editTitle.trim() && editTitle.trim() !== room.title ? { title: editTitle.trim() } : {}),
            ...(editHost ? { hostBotId: editHost } : {}),
            replyMode: editMode,
          }),
        },
      );
      onRoomUpdated(res.room);
      onLinksUpdated(res.links);
      setShowSettings(false);
      setNotice("群聊设置已同步至 Agent Home。");
    });
  };

  const addMember = () => {
    if (!addBotId) return;
    void runAction(async () => {
      const res = await request<{ room: HomeChatRoom }>(`${chatBase}/rooms/${encodeURIComponent(room.id)}/members`, {
        method: "POST",
        body: JSON.stringify({ botId: addBotId }),
      });
      onRoomUpdated(res.room);
      setAddBotId("");
      setNotice("已将 Bot 加入该群聊。");
    });
  };

  const removeMember = (botId: string) =>
    runAction(async () => {
      const res = await request<{ room: HomeChatRoom }>(
        `${chatBase}/rooms/${encodeURIComponent(room.id)}/members/${encodeURIComponent(botId)}`,
        { method: "DELETE" },
      );
      onRoomUpdated(res.room);
      setNotice("已移出群聊成员。");
    });

  const pushQuickCard = (text: string, clearIdea = false) =>
    runAction(async () => {
      const trimmed = text.trim();
      if (!trimmed) return;
      await request(`${chatBase}/rooms/${encodeURIComponent(room.id)}/messages`, {
        method: "POST",
        body: JSON.stringify({
          text: trimmed,
          ...(ideaCitation && clearIdea ? { ideaId: ideaCitation.id } : {}),
        }),
      });
      setQuickBody("");
      if (clearIdea) onClearIdea();
      onClearDraft();
      setNotice("已推送到原生 Agent Home 群聊，点击上方「前往原生 Agent Home 打开群聊 ↗」即可查看完整对话。");
    });

  return (
    <article className="hr-chat-panel">
      <header className="hr-chat-head">
        <div>
          <div className="hr-chat-title-row">
            <h2>{room.title}</h2>
            <span className="hr-badge" data-tone={room.status === "active" ? "ok" : "warn"}>
              {room.status === "active" ? "进行中" : "已暂停"}
            </span>
            {room.replyMode && (
              <span className="hr-badge">{replyModeLabels[room.replyMode] ?? room.replyMode}</span>
            )}
            {roomLinks.map((item) => (
              <span key={item.scopeKey} className="hr-badge" data-tone="accent">
                {scopeLabel(item.scopeKey)}
              </span>
            ))}
          </div>
          <p className="hr-muted" style={{ margin: "6px 0 0" }}>
            房间 ID：<code>{room.id}</code> · 共 {memberBots.length} 位 Bot 成员
          </p>
        </div>
        <div className="hr-chat-controls">
          <a className="hr-primary hr-launch-btn" href={`${origin}/#/bot`} target="_blank" rel="noreferrer">
            前往原生 Agent Home 打开群聊 ↗
          </a>
          <button type="button" disabled={busy} onClick={() => void toggleDefault()}>
            {isDefault ? "取消默认提醒群" : "设为默认提醒群"}
          </button>
          <button type="button" disabled={busy} onClick={() => setShowSettings((v) => !v)}>
            {showSettings ? "收起设置" : "群设置"}
          </button>
          <button type="button" disabled={busy} onClick={() => void toggleStatus()}>
            {room.status === "active" ? "暂停" : "恢复"}
          </button>
        </div>
      </header>

      {error && <p role="alert" className="hr-error">{error}</p>}
      {notice && (
        <div className="hr-notice" role="status">
          <span>{notice}</span>
          <a href={`${origin}/#/bot`} target="_blank" rel="noreferrer">打开原生 Agent Home ↗</a>
        </div>
      )}

      {/* 原生直达说明卡：不再重复渲染劣质聊天消息流 */}
      <section className="hr-launch-card" aria-label="原生对话直达">
        <div>
          <strong>完整群聊对话在原生 Agent Home 中打开</strong>
          <p className="hr-muted">
            流式回复、思考过程折叠、工具调用证据与附件展示统一由原生 Agent Home 承载，避免在此重复渲染。
            {isExecutiveRoom && " 如果只想看 Super Bot 的结构化简报与审批结论，可直接去「总裁信箱」。"}
          </p>
        </div>
        <div className="hr-launch-actions">
          <a className="hr-primary hr-launch-btn" href={`${origin}/#/bot`} target="_blank" rel="noreferrer">
            直达原生 Agent Home ↗
          </a>
          {isExecutiveRoom && (
            <a className="hr-secondary-link" href="#mailbox">打开总裁信箱查看简报 ↗</a>
          )}
        </div>
      </section>

      {showSettings && (
        <form className="hr-settings" onSubmit={saveSettings}>
          <label>
            群聊名称
            <input value={editTitle} maxLength={120} disabled={busy} onChange={(e) => setEditTitle(e.target.value)} />
          </label>
          <label>
            回复模式
            <select value={editMode} disabled={busy} onChange={(e) => setEditMode(e.target.value as "coordinator" | "all-members")}>
              <option value="coordinator">主控协调</option>
              <option value="all-members">全员参与</option>
            </select>
          </label>
          {memberBots.length > 0 && (
            <label>
              主控 Bot
              <select value={editHost} disabled={busy} onChange={(e) => setEditHost(e.target.value)}>
                {memberBots.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select>
            </label>
          )}
          <button type="submit" className="hr-primary" disabled={busy}>保存设置</button>
        </form>
      )}

      {/* 群内 Bot 成员卡片墙 */}
      <section className="hr-section" aria-label="群内 Bot 成员">
        <div className="hr-section-head">
          <h3>群内 Bot 成员（{memberBots.length}）</h3>
          {availableToAdd.length > 0 && (
            <div className="hr-add-member">
              <select value={addBotId} disabled={busy} onChange={(e) => setAddBotId(e.target.value)}>
                <option value="">+ 选择要加入本群的 Bot…</option>
                {availableToAdd.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select>
              <button type="button" disabled={busy || !addBotId} onClick={addMember}>加入群聊</button>
            </div>
          )}
        </div>
        <div className="hr-member-cards">
          {memberBots.map((bot) => {
            const st = botStatusMeta(bot.status);
            const isHost = room.hostBotId === bot.id;
            return (
              <div key={bot.id} className="hr-bot-card">
                <button type="button" className="hr-bot-card-main" onClick={() => onSelectBot(bot.id)}>
                  <div className="hr-bot-card-top">
                    <span className="hr-status-dot" data-tone={st.tone} />
                    <strong>{bot.name}</strong>
                    {isHost && <span className="hr-badge" data-tone="accent">主控</span>}
                  </div>
                  <small>{bot.title || bot.groupName || bot.id}</small>
                </button>
                <div className="hr-bot-card-actions">
                  <a href={`${origin}/#/agents/bots?bot=${encodeURIComponent(bot.id)}&focus=permissions`} target="_blank" rel="noreferrer">
                    原生详情 ↗
                  </a>
                  {room.botIds.length > 1 && (
                    <button
                      type="button"
                      className="hr-link-btn"
                      disabled={busy}
                      title={`将 ${bot.name} 移出本群`}
                      onClick={() => void removeMember(bot.id)}
                    >
                      移出
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {/* 仅当带入想法/待办草稿时，提供轻量卡片推送，不展示历史聊天流 */}
      {(ideaCitation || quickBody || pending.length > 0) && (
        <section className="hr-section" aria-label="OPC 业务卡片快捷推送">
          <div className="hr-section-head">
            <h3>向此群推送 OPC 事项卡片</h3>
            <span className="hr-muted">推送后请在原生 Agent Home 继续讨论</span>
          </div>
          {ideaCitation && (
            <div className="hr-idea-cite">
              <div>
                <strong>引用想法 · {ideaCitation.title}</strong>
                <a href={"#ideas?idea=" + encodeURIComponent(ideaCitation.id)}>查看原想法 ↗</a>
              </div>
              <button type="button" disabled={busy} onClick={() => { onClearIdea(); setQuickBody(""); }}>取消引用</button>
            </div>
          )}
          {quickBody && (
            <form
              className="hr-quick-push"
              onSubmit={(e) => {
                e.preventDefault();
                void pushQuickCard(quickBody, true);
              }}
            >
              <textarea rows={3} value={quickBody} disabled={busy} onChange={(e) => setQuickBody(e.target.value)} />
              <div className="hr-create-actions">
                <button type="submit" className="hr-primary" disabled={busy || !quickBody.trim()}>
                  {busy ? "推送中…" : "推送到该群并继续"}
                </button>
              </div>
            </form>
          )}
          {pending.length > 0 && (
            <div className="hr-pending-strip">
              <strong>当前待决事项（{pending.length}）</strong>
              <ul>
                {pending.slice(0, 5).map((item) => (
                  <li key={item.id}>
                    <a href={decisionTarget(item)}>{messageText(item).title} ↗</a>
                    <button type="button" disabled={busy} onClick={() => void pushQuickCard(formatPendingShare(item))}>
                      推送提醒到本群
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>
      )}
    </article>
  );
}

function BotProfilePanel({
  bot,
  origin,
  rooms,
  onSelectRoom,
}: {
  bot: HomeChatBot;
  origin: string;
  rooms: HomeChatRoom[];
  onSelectRoom: (roomId: string) => void;
}) {
  const st = botStatusMeta(bot.status);
  const joinedRooms = useMemo(() => rooms.filter((r) => r.botIds.includes(bot.id)), [rooms, bot.id]);
  const descLines = (bot.description || "").trim().split(/\r?\n/).filter(Boolean);
  const summaryLines = descLines.slice(0, 4);

  return (
    <article className="hr-chat-panel">
      <header className="hr-chat-head">
        <div>
          <div className="hr-chat-title-row">
            <h2>{bot.name}</h2>
            <span className="hr-badge" data-tone={st.tone === "ok" ? "ok" : st.tone === "warn" ? "warn" : undefined}>
              {st.label}
            </span>
            {bot.groupName && <span className="hr-badge" data-tone="accent">{bot.groupName}</span>}
          </div>
          <p className="hr-muted" style={{ margin: "6px 0 0" }}>
            {bot.title ? `${bot.title} · ` : ""}botId: <code>{bot.id}</code>
            {typeof bot.completedCount === "number" &&
              ` · 已完成 ${bot.completedCount} · 待处理 ${bot.pendingCount ?? 0} · 运行中 ${bot.activeWorkCount ?? 0}`}
          </p>
        </div>
        <div className="hr-chat-controls">
          <a className="hr-primary hr-launch-btn" href={`${origin}/#/bot`} target="_blank" rel="noreferrer">
            在原生 Agent Home 对话 ↗
          </a>
          <a
            className="hr-secondary-link"
            href={`${origin}/#/agents/bots?bot=${encodeURIComponent(bot.id)}&focus=permissions`}
            target="_blank"
            rel="noreferrer"
          >
            权限与连接设置 ↗
          </a>
          <a
            className="hr-secondary-link"
            href={`${origin}/#/tasks/flows?bot=${encodeURIComponent(bot.id)}`}
            target="_blank"
            rel="noreferrer"
          >
            任务流轨迹 ↗
          </a>
        </div>
      </header>

      <section className="hr-section" aria-label="Bot 职责与契约">
        <h3>职责与角色说明</h3>
        {descLines.length > 0 ? (
          <div className="hr-bot-desc">
            {summaryLines.map((line, i) => <p key={i}>{line}</p>)}
            {descLines.length > 4 && (
              <details>
                <summary>展开完整提示词与契约（共 {descLines.length} 行）</summary>
                <pre>{bot.description}</pre>
              </details>
            )}
          </div>
        ) : (
          <p className="hr-muted">该 Bot 暂未填写额外角色说明，可在原生 Agent Home 中配置。</p>
        )}
      </section>

      <section className="hr-section" aria-label="所在群聊">
        <h3>已加入的群聊（{joinedRooms.length}）</h3>
        {joinedRooms.length === 0 ? (
          <p className="hr-muted">暂未加入任何群聊。可在左侧切换到「群聊」列表中将其拉入群。</p>
        ) : (
          <div className="hr-member-cards">
            {joinedRooms.map((room) => (
              <div key={room.id} className="hr-bot-card">
                <button type="button" className="hr-bot-card-main" onClick={() => onSelectRoom(room.id)}>
                  <div className="hr-bot-card-top">
                    <strong>{room.title}</strong>
                    {room.hostBotId === bot.id && <span className="hr-badge" data-tone="accent">主控</span>}
                  </div>
                  <small>
                    {room.botIds.length} 位 Bot · {replyModeLabels[room.replyMode ?? ""] ?? room.replyMode ?? "群聊"}
                  </small>
                </button>
                <div className="hr-bot-card-actions">
                  <a href={`${origin}/#/bot`} target="_blank" rel="noreferrer">原生打开 ↗</a>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </article>
  );
}

export function HomeRoom({
  project,
  pending = [],
  nav,
}: {
  project?: string;
  pending?: ZoomMessage[];
  nav?: ReactNode;
}) {
  const initialParams = useMemo(() => new URLSearchParams(location.hash.split("?")[1]), []);
  const [overview, setOverview] = useState<HomeChatOverview | null>(null);
  const [railTab, setRailTab] = useState<"rooms" | "bots">(() => (initialParams.get("bot") ? "bots" : "rooms"));
  const [search, setSearch] = useState("");
  const [selectedRoomId, setSelectedRoomId] = useState<string>(() => initialParams.get("room") ?? "");
  const [selectedBotId, setSelectedBotId] = useState<string>(() => initialParams.get("bot") ?? "");
  const [creating, setCreating] = useState(false);
  const [reload, setReload] = useState(0);
  const [ideaParam, setIdeaParam] = useState<string>(() => initialParams.get("idea") ?? "");
  const [draftText, setDraftText] = useState<string>(() => initialParams.get("draft") ?? "");
  const [ideaCitation, setIdeaCitation] = useState<IdeaCitation | null>(null);

  useEffect(() => {
    const sync = () => {
      if (!location.hash.startsWith("#home-room")) return;
      const params = new URLSearchParams(location.hash.split("?")[1]);
      if (params.get("room")) {
        setSelectedRoomId(params.get("room") ?? "");
        setRailTab("rooms");
        setCreating(false);
      }
      if (params.get("bot")) {
        setSelectedBotId(params.get("bot") ?? "");
        setRailTab("bots");
        setCreating(false);
      }
      setIdeaParam(params.get("idea") ?? "");
      if (params.get("draft")) setDraftText(params.get("draft") ?? "");
    };
    window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
  }, []);

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
        if (!found) { setIdeaCitation(null); return; }
        const sources = company.information
          .filter((note) => found.sources.includes(note.id))
          .map((note) => ({ reference: note.reference || note.title, body: note.body || note.title }));
        setIdeaCitation({ id: found.id, title: found.title, body: found.body, sources });
      })
      .catch(() => { if (!abort.signal.aborted) setIdeaCitation(null); });
    return () => abort.abort();
  }, [ideaParam]);

  useEffect(() => {
    const abort = new AbortController();
    request<HomeChatOverview>(chatBase + "/overview", { signal: abort.signal })
      .catch(
        (err): HomeChatOverview => ({
          available: false,
          origin: "http://127.0.0.1:37070",
          reason: label(err),
          rooms: [],
          bots: [],
          groups: [],
          links: [],
        }),
      )
      .then((chatData) => {
        if (!abort.signal.aborted) setOverview(chatData);
      });
    return () => abort.abort();
  }, [reload]);

  const sortedBots = useMemo(() => {
    const list = [...(overview?.bots ?? [])];
    const rank = (b: HomeChatBot) => {
      if (b.id === "super-bot") return 0;
      if (b.groupName?.includes("OPC") || b.name.startsWith("OPC ")) return 1;
      if (b.status === "running") return 2;
      if (b.status === "idle") return 3;
      return 4;
    };
    return list.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name, "zh-CN"));
  }, [overview?.bots]);

  const query = search.trim().toLowerCase();
  const filteredRooms = useMemo(
    () => (overview?.rooms ?? []).filter((r) => !query || r.title.toLowerCase().includes(query)),
    [overview?.rooms, query],
  );
  const filteredBots = useMemo(
    () =>
      sortedBots.filter(
        (b) =>
          !query ||
          b.name.toLowerCase().includes(query) ||
          (b.title ?? "").toLowerCase().includes(query) ||
          (b.groupName ?? "").toLowerCase().includes(query) ||
          b.id.toLowerCase().includes(query),
      ),
    [sortedBots, query],
  );

  const roomCountByBot = useMemo(() => {
    const counts = new Map<string, number>();
    for (const r of overview?.rooms ?? []) {
      for (const id of r.botIds) counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    return counts;
  }, [overview?.rooms]);

  const linksByRoom = useMemo(() => {
    const map = new Map<string, HomeChatLink[]>();
    for (const item of overview?.links ?? []) {
      const list = map.get(item.remoteRoom) ?? [];
      list.push(item);
      map.set(item.remoteRoom, list);
    }
    return map;
  }, [overview?.links]);

  const resolvedRoom = useMemo(() => {
    if (!overview?.rooms.length) return null;
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
  }, [overview, selectedRoomId, project]);

  const resolvedBot = useMemo(() => {
    if (!sortedBots.length) return null;
    if (selectedBotId) {
      const exact = sortedBots.find((b) => b.id === selectedBotId);
      if (exact) return exact;
    }
    return sortedBots[0];
  }, [sortedBots, selectedBotId]);

  const origin = overview?.origin || "http://127.0.0.1:37070";

  return (
    <section className="zo-product hr-page" aria-label="Agent Home 群聊与 Bot">
      <header className="zo-product-head hr-top-head">
        {nav}
        <div>
          <a href="#overview">全局看板 ↗</a>
          {" · "}
          <a href="#mailbox">总裁信箱 ↗</a>
          <h1>Agent Home 群聊与 Bot</h1>
        </div>
        <div className="hr-top-actions">
          <a className="hr-primary hr-launch-btn" href={`${origin}/#/bot`} target="_blank" rel="noreferrer">
            打开原生 Agent Home ↗
          </a>
          <button type="button" onClick={() => setReload((n) => n + 1)}>刷新</button>
          <button
            type="button"
            disabled={!overview?.available}
            onClick={() => setCreating((v) => !v)}
          >
            {creating ? "取消新建" : "+ 新建群聊"}
          </button>
        </div>
      </header>

      <div className="hr-shell">
        <aside className="hr-rail" aria-label="群聊与 Bot 成员目录">
          <div className="hr-rail-tabs" role="tablist" aria-label="切换群聊或 Bot 列表">
            <button
              type="button"
              role="tab"
              aria-selected={railTab === "rooms"}
              onClick={() => { setRailTab("rooms"); setCreating(false); }}
            >
              群聊 ({overview ? overview.rooms.length : "…"})
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={railTab === "bots"}
              onClick={() => { setRailTab("bots"); setCreating(false); }}
            >
              Bot 成员 ({overview ? overview.bots.length : "…"})
            </button>
          </div>

          <input
            type="search"
            className="hr-rail-search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={railTab === "rooms" ? "筛选群聊名称…" : "筛选 Bot 名称 / 分组 / 角色…"}
          />

          {!overview && <p className="hr-muted">正在连接 Agent Home…</p>}
          {overview && !overview.available && (
            <div className="hr-offline" role="status">
              <p>{overview.reason || "暂未连接到 Agent Home 服务。"}</p>
              <small>地址：{overview.origin}</small>
              <button type="button" onClick={() => setReload((n) => n + 1)}>重新连接</button>
            </div>
          )}

          {overview?.available && railTab === "rooms" && (
            filteredRooms.length === 0 ? (
              <p className="hr-muted">{query ? "没有匹配的群聊。" : "暂无群聊，可点击右上角新建。"}</p>
            ) : (
              <ul className="hr-room-list">
                {filteredRooms.map((room) => {
                  const active = !creating && resolvedRoom?.id === room.id;
                  const roomTags = linksByRoom.get(room.id) ?? [];
                  return (
                    <li key={room.id} className="hr-rail-row">
                      <button
                        type="button"
                        className="hr-room-item"
                        aria-current={active ? "true" : undefined}
                        onClick={() => {
                          setCreating(false);
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
                      <a
                        className="hr-row-jump"
                        href={`${origin}/#/bot`}
                        target="_blank"
                        rel="noreferrer"
                        title="直接前往原生 Agent Home"
                        aria-label={`在原生 Agent Home 打开 ${room.title}`}
                      >
                        ↗
                      </a>
                    </li>
                  );
                })}
              </ul>
            )
          )}

          {overview?.available && railTab === "bots" && (
            filteredBots.length === 0 ? (
              <p className="hr-muted">{query ? "没有匹配的 Bot。" : "Agent Home 中暂无可用 Bot。"}</p>
            ) : (
              <ul className="hr-room-list">
                {filteredBots.map((bot) => {
                  const active = !creating && resolvedBot?.id === bot.id;
                  const st = botStatusMeta(bot.status);
                  const roomCount = roomCountByBot.get(bot.id) ?? 0;
                  return (
                    <li key={bot.id} className="hr-rail-row">
                      <button
                        type="button"
                        className="hr-room-item"
                        aria-current={active ? "true" : undefined}
                        onClick={() => {
                          setCreating(false);
                          setSelectedBotId(bot.id);
                        }}
                      >
                        <span className="hr-bot-list-title">
                          <span className="hr-status-dot" data-tone={st.tone} />
                          <strong>{bot.name}</strong>
                        </span>
                        <small>
                          {bot.title || st.label}
                          {roomCount > 0 ? ` · ${roomCount} 个群` : ""}
                        </small>
                        {bot.groupName && <span className="hr-room-tags">{bot.groupName}</span>}
                      </button>
                      <a
                        className="hr-row-jump"
                        href={`${origin}/#/agents/bots?bot=${encodeURIComponent(bot.id)}&focus=permissions`}
                        target="_blank"
                        rel="noreferrer"
                        title="在原生 Agent Home 查看该 Bot"
                        aria-label={`在原生 Agent Home 查看 ${bot.name}`}
                      >
                        ↗
                      </a>
                    </li>
                  );
                })}
              </ul>
            )
          )}
        </aside>

        <div className="hr-main">
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
                setRailTab("rooms");
                setSelectedRoomId(room.id);
              }}
            />
          ) : railTab === "bots" && resolvedBot && overview ? (
            <BotProfilePanel
              bot={resolvedBot}
              origin={origin}
              rooms={overview.rooms}
              onSelectRoom={(roomId) => {
                setSelectedRoomId(roomId);
                setRailTab("rooms");
              }}
            />
          ) : resolvedRoom && overview ? (
            <RoomDirectoryPanel
              room={resolvedRoom}
              origin={origin}
              bots={overview.bots}
              links={overview.links}
              pending={pending}
              ideaCitation={ideaCitation}
              draftText={draftText}
              onClearIdea={() => setIdeaCitation(null)}
              onClearDraft={() => setDraftText("")}
              onSelectBot={(botId) => {
                setSelectedBotId(botId);
                setRailTab("bots");
              }}
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
              <h2>Agent Home 群聊与 Bot 目录</h2>
              <p>
                左侧可随时切换查看所有「群聊」和「Bot 成员」，点击「前往原生 Agent Home ↗」直接在原生界面聊天；若希望异步收发 Super Bot 汇报和审批，请使用左侧「总裁信箱」。
              </p>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
