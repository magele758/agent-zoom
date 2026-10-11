# See who is here

See who is here groups the channel under 在场 by person. A person can own several agents. Each agent row shows the handle used for @, and under it the live duty: 实现, 评审, or 测试 with the task title, or 空闲. Choosing a handle puts `@handle` in the message box.

## Sub-features

- `roster-people` shows the person who entered, with that person's agents nested underneath.
- `roster-duty` shows 空闲 when the agent holds no active slot.
- `roster-mention` inserts `@handle` from an agent row without sending.

## How to get to it (user POV)

- Enter the studio. On a wide window, 在场 is the right column, under the 这台电脑 chart.
- On a narrow window, choose the bottom tab `任务`. 在场 is on that panel.
- Choose the `builder` row. Its accessible name starts with `builder`.

## Driving it with agent-browser

Preconditions:

- `verify.sh doctor` printed `doctor ok`.
- The session is on 大厅 as `验收员`. Follow [enter.md](./enter.md) if the gate is showing.
- The viewport is wide enough that the right column is visible. Run `agent-browser --session verify-$RUN_ID set viewport 1280 800` before looking for 在场.
- Do not open a task first. A fresh room has no claim, so every demo agent reads 空闲.

- **Read the list.** Run `agent-browser --session verify-$RUN_ID eval 'document.querySelector("[data-testid=roster]")?.innerText ?? ""'`. The text contains `验收员`, `4 个 agent`, `builder`, `maker`, `reviewer`, `qa`, and `空闲`.
- **Insert from the roster.** Run `agent-browser --session verify-$RUN_ID find testid roster-builder click`. Then `agent-browser --session verify-$RUN_ID eval 'document.querySelector("#composer")?.value ?? ""'`. The value contains `@builder`.
- **Proof.** Run `agent-browser --session verify-$RUN_ID screenshot "$EVIDENCE/roster/roster.png"` and save the roster eval text to `$EVIDENCE/roster/roster.txt`. The screenshot shows 在场 grouped under 验收员, `空闲` on builder, and `@builder` in the message box. Do not choose `发送`.

## Gotchas

- The agent button accessible name is `builder，实现 · 空闲 · 演示`, not `验收员 / builder`. Use `data-testid` `roster-builder`. The identity select is `group-builder`. The level select is `level-builder`. The stop button is `stop-builder`.
- Demo handles stay `builder`, `maker`, `reviewer`, and `qa`. Those names are how you @ them. The person and the duty line are what say who is working.
- Below 860px the right column is hidden until the `任务` tab is chosen. A proof taken on the default mobile width that only looks at the message column will miss 在场.
- Clicking the handle moves the mobile UI back to 消息. Check the message box after the click, not the roster pane.
- Online dots follow heartbeats. A gray dot does not mean the handle is missing.
