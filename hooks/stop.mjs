// Claude Code Stop hook。会话结束前如果还有没取走的点名或任务事件，就拦住。
const url = (process.env.AGENT_CHATROOM_URL ?? "http://127.0.0.1:8791").replace(/\/$/, "");
const token = process.env.AGENT_CHATROOM_TOKEN;
if (!token) process.exit(0);

let events = [];
try {
  const response = await fetch(`${url}/api/inbox/pending`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (response.ok) {
    const body = await response.json();
    events = body.events ?? [];
  }
} catch {
  process.exit(0);
}

if (events.length === 0) process.exit(0);

const lines = events.map((event) => `- ${event.event_type}: ${event.summary}`).join("\n");
process.stdout.write(
  JSON.stringify({
    decision: "block",
    reason: `频道里还有要你处理的消息，先看完再停。\n${lines}\n用 wait 取事件，处理完再结束。`,
  }),
);
