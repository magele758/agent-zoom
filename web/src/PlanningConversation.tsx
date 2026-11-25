import { useEffect, useRef, useState, type FormEvent } from "react";
import type { PlanningChatView } from "../../src/planning-chat-types";
import { request } from "./api";

const endpoint = "/api/opc/planning/conversation";

export function PlanningConversation({ project, onCreated }: { project: string; onCreated: () => Promise<void> }) {
  const [view, setView] = useState<PlanningChatView | null>(null);
  const [text, setText] = useState("");
  const [draftId, setDraftId] = useState(() => crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const history = useRef<HTMLOListElement>(null);
  const latest = view?.turns.at(-1);
  const waiting = latest?.status === "pending";

  useEffect(() => {
    if (history.current) history.current.scrollTop = history.current.scrollHeight;
  }, [latest?.id, latest?.status, latest?.taskId, latest?.runId]);

  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try {
        const data = await request<PlanningChatView>(endpoint + "?" + new URLSearchParams({ project }), {
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        setView(data);
        setError("");
        if (data.turns.at(-1)?.status === "pending") timer = setTimeout(load, 2000);
      } catch (failure) {
        if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : "读取会话失败");
      }
    };
    if (!view || (waiting && !busy)) void load();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [project, retry, Boolean(view), waiting, busy]);

  async function send(event: FormEvent) {
    event.preventDefault();
    if (busy || waiting || !text.trim()) return;
    setBusy(true);
    setError("");
    try {
      const data = await request<PlanningChatView>(endpoint + "/messages", {
        method: "POST",
        body: JSON.stringify({ project, id: draftId, text: text.trim() }),
      });
      setView(data);
      setText("");
      setDraftId(crypto.randomUUID());
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "消息发送失败");
    } finally {
      setBusy(false);
    }
  }

  async function confirm(turnId: string, dispatch: boolean) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      setView(await request<PlanningChatView>(endpoint + "/confirm", {
        method: "POST", body: JSON.stringify({ project, turnId, dispatch }),
      }));
      await onCreated();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "确认任务失败");
    } finally {
      setBusy(false);
    }
  }

  return <section className="tp-creator tp-conversation" aria-label="和 Bot 聊任务">
    <header>
      <h3>和 Bot 聊任务</h3>
      <p>直接说想做什么。可以多聊几轮，等 Super Bot 整理好范围和验收标准，再确认建卡或派工。</p>
    </header>
    {error && <p role="alert">{error} {(!view || waiting) && <button type="button" onClick={() => setRetry(n => n + 1)}>重读会话</button>}</p>}
    {!view && !error && <p role="status">正在读取会话…</p>}
    {view && <>
      {view.turns.length > 0 && <ol ref={history} className="tp-conversation-turns" aria-label="对话记录">
        {view.turns.map(turn => <li key={turn.id}>
          <p><strong>你</strong><span>{turn.text}</span></p>
          {(turn.reply || turn.error || turn.status === "pending") && <p className="tp-conversation-answer">
            <strong>{turn.botName || "Super Bot"}</strong>
            <span>{turn.reply || turn.error || "正在整理…"}</span>
          </p>}
          {turn.taskId && <p className="tp-conversation-receipt">
            {turn.runId ? <a href={"#dark-factory?" + new URLSearchParams({ run: turn.runId })}>查看派工进度 ↗</a> : "已创建看板任务"}
          </p>}
        </li>)}
      </ol>}
      {latest?.proposal && latest.status === "answered" && !latest.runId && <section className="tp-conversation-proposal" aria-label="待确认任务">
        <h4>{latest.proposal.title}</h4>
        <p>{latest.proposal.project || view.project || "默认项目"}{latest.proposal.agentId && " · 执行者 " + latest.proposal.agentId}</p>
        <p>{latest.proposal.description}</p>
        {latest.error && <p role="alert">{latest.error}</p>}
        <div>
          {!latest.taskId && <button type="button" disabled={busy} onClick={() => void confirm(latest.id, false)}>确认建卡</button>}
          {latest.proposal.agentId && <button type="button" disabled={busy} className="tp-primary"
            onClick={() => void confirm(latest.id, true)}>{latest.taskId ? "确认派工" : "确认建卡并派工"}</button>}
        </div>
      </section>}
      <form onSubmit={send}>
        <label>任务想法或补充说明
          <textarea rows={3} value={text} maxLength={2000} disabled={busy} placeholder="例如，给 PageLens 增加失败重试。先帮我理清范围和验收标准。"
            onChange={event => { setText(event.target.value); setDraftId(crypto.randomUUID()); }} />
        </label>
        <button className="tp-primary" disabled={busy || waiting || !text.trim()}>
          {waiting ? "等待 Bot 回复…" : "发送给 Super Bot"}
        </button>
      </form>
    </>}
  </section>;
}
