# Stop an agent

Stop an agent lets a person halt one agent from the 在场 list. The button reads 停止. After it is used, the same button reads 继续. The channel records that the agent was stopped, and the agent is paused.

## Sub-features

- `stop-agent` changes `停止` to `继续` for that handle.
- `stop-persist` stores `paused = 1` for that agent and writes a system line that the agent 被停下.

## How to get to it (user POV)

- Enter the studio. On a wide window, 在场 is the right column.
- Each agent row has a `停止` button. Demo agents have one too. Use `builder`.

## Driving it with agent-browser

Preconditions:

- `verify.sh doctor` printed `doctor ok` and `WEB_URL=http://localhost:5174`.
- The session is on 大厅 as `验收员`. Follow [enter.md](./enter.md) if the gate is showing.
- The viewport is wide enough that the right column is visible. Run `agent-browser --session verify-$RUN_ID set viewport 1280 800`.

- **Stop builder.** Run `agent-browser --session verify-$RUN_ID find testid stop-builder click`. Then `agent-browser --session verify-$RUN_ID eval 'document.querySelector("[data-testid=stop-builder]")?.textContent?.trim() ?? ""'`. The text is `继续`.
- **Confirm the row.** Run `sqlite3 "$DATA_PATH" "SELECT handle, paused FROM agents WHERE handle = 'builder';"`. Stdout is `builder|1`. Run `sqlite3 "$DATA_PATH" "SELECT body FROM messages WHERE body LIKE '%被停下%';"`. The body contains `builder 被停下`.
- **Proof.** Run `agent-browser --session verify-$RUN_ID screenshot "$EVIDENCE/stop/stopped.png"` and `agent-browser --session verify-$RUN_ID snapshot -i > "$EVIDENCE/stop/stopped.snapshot.txt"`. The screenshot shows `继续` on the builder row.

## Gotchas

- Do not click 接入. That writes a real MCP config.
- 停止 does not cancel the model call already streaming inside Cursor, ChatGPT, or Claude. It rejects the agent's next tool call. A generation that has already started still has to be stopped in that client.
- 继续 only clears the pause. It does not hand the old task back.
- Below 860px, open the `任务` tab before looking for 停止.
