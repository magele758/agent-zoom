import { useState, type FormEvent, type MouseEvent } from "react";
import { request } from "./api";
import "./dual-track.css";

export function HerdrActions({
  address,
  isBlocked = false,
  compact = false,
  allowSend = true,
  onSent,
}: {
  address?: string | null;
  isBlocked?: boolean;
  compact?: boolean;
  allowSend?: boolean;
  onSent?: () => void;
}) {
  const [focusState, setFocusState] = useState<"idle" | "busy" | "ok" | "err">("idle");
  const [showPanel, setShowPanel] = useState(false);
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);
  const [feedback, setFeedback] = useState<{ kind: "ok" | "warn" | "err"; text: string } | null>(null);
  const [screenLines, setScreenLines] = useState<string[] | null>(null);
  const [loadingScreen, setLoadingScreen] = useState(false);

  if (!address) return null;

  const stop = (e: MouseEvent) => e.stopPropagation();

  const handleFocus = async (e: MouseEvent) => {
    e.stopPropagation();
    setFocusState("busy");
    setFeedback(null);
    try {
      await request("/api/opc/herdr/focus", {
        method: "POST",
        body: JSON.stringify({ address }),
      });
      setFocusState("ok");
      window.setTimeout(() => setFocusState((cur) => (cur === "ok" ? "idle" : cur)), 2000);
    } catch (err) {
      setFocusState("err");
      setFeedback({
        kind: "err",
        text: err instanceof Error ? err.message : "切换 Herdr 失败",
      });
    }
  };

  const handleLoadScreen = async (e: MouseEvent) => {
    e.stopPropagation();
    setLoadingScreen(true);
    setFeedback(null);
    try {
      const res = await request<{ lines: string[] }>(
        `/api/opc/herdr/screen?address=${encodeURIComponent(address)}&lines=16`,
      );
      setScreenLines(res.lines);
      setShowPanel(true);
    } catch (err) {
      setFeedback({
        kind: "err",
        text: err instanceof Error ? err.message : "读取终端屏幕失败",
      });
    } finally {
      setLoadingScreen(false);
    }
  };

  const handleSend = async (e: FormEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const text = message.trim();
    if (!text) return;
    setSending(true);
    setFeedback(null);
    try {
      await request("/api/opc/herdr/send", {
        method: "POST",
        body: JSON.stringify({ address, message: text }),
      });
      setMessage("");
      setFeedback({ kind: "ok", text: `已发送到 ${address}` });
      onSent?.();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "发送失败";
      const blocked = /阻塞|blocked|亲自确认|安全确认/i.test(msg);
      setFeedback({ kind: blocked ? "warn" : "err", text: msg });
    } finally {
      setSending(false);
    }
  };

  return (
    <span className={`dt-herdr-actions${compact ? " is-compact" : ""}`} onClick={stop}>
      <button
        type="button"
        className="dt-mini-btn dt-focus-btn"
        disabled={focusState === "busy"}
        title={`在 Herdr 桌面端切换到终端 ${address}`}
        onClick={(e) => void handleFocus(e)}
      >
        {focusState === "busy" ? "切换中…" : focusState === "ok" ? "✓ 已切屏" : "↗ 切到 Herdr"}
      </button>
      {allowSend && (
        <button
          type="button"
          className={`dt-mini-btn${showPanel ? " primary" : ""}`}
          title={
            isBlocked
              ? "终端处于阻塞态：建议先查看屏幕或切到 Herdr 亲自确认"
              : `向 Herdr 终端 ${address} 发送快捷指令`
          }
          onClick={(e) => {
            e.stopPropagation();
            setShowPanel((v) => !v);
            setFeedback(null);
          }}
        >
          {isBlocked ? "👁 看现场" : "💬 发指令"}
        </button>
      )}
      {showPanel && (
        <div className="dt-herdr-popover" onClick={stop}>
          <div className="dt-herdr-popover-head">
            <strong>Herdr · {address}</strong>
            <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <button
                type="button"
                className="dt-mini-btn"
                disabled={loadingScreen}
                onClick={(e) => void handleLoadScreen(e)}
              >
                {loadingScreen ? "读取中…" : screenLines ? "↻ 刷新屏显" : "👁 看最后 16 行"}
              </button>
              <button
                type="button"
                className="dt-mini-btn"
                onClick={(e) => {
                  e.stopPropagation();
                  setShowPanel(false);
                }}
              >
                收起
              </button>
            </div>
          </div>

          {screenLines && (
            <pre className="dt-herdr-screen">
              {screenLines.length > 0 ? screenLines.join("\n") : "（当前屏幕无可见输出）"}
            </pre>
          )}

          {isBlocked ? (
            <div className="dt-herdr-warn">
              该终端正处于权限/确认阻塞态（blocked）。为防误授权，请点击
              <button type="button" className="dt-mini-btn primary" onClick={(e) => void handleFocus(e)}>
                ↗ 切到 Herdr 亲自确认
              </button>
            </div>
          ) : (
            <form className="dt-herdr-send-form" onSubmit={(e) => void handleSend(e)}>
              <input
                type="text"
                placeholder={`输入要发给 ${address} 的指令并回车…`}
                value={message}
                disabled={sending}
                onChange={(e) => setMessage(e.target.value)}
              />
              <button type="submit" className="dt-mini-btn primary" disabled={sending || !message.trim()}>
                {sending ? "发送中…" : "发送"}
              </button>
            </form>
          )}

          {feedback && (
            <div className={`dt-herdr-feedback is-${feedback.kind}`} role="status">
              <span>{feedback.text}</span>
              {feedback.kind === "warn" && (
                <button type="button" className="dt-mini-btn primary" onClick={(e) => void handleFocus(e)}>
                  ↗ 切到 Herdr
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </span>
  );
}
