# Local coding agents

Local coding agents keeps the installed coding apps behind a compact chart at the top of the right column. The chart shows how many are already in this channel. Choosing it opens a dialog. Each app that can be added has an identity select, a level select, and an 接入 button. A row already in this channel says 已接入. A row whose one-click setup is not built says 仅显示.

## Sub-features

- `local-chart` shows 这台电脑 as a short bar chart. The client list is not on the page until the chart is opened.
- `local-dialog` lists one row per installed app, with 接入, 已接入, or 仅显示.
- `local-level` puts a Lv1–Lv5 select on each row that can still be added. The default is Lv1.
- `local-group` puts an identity select on each row that can still be added. The default is 实现. Choosing 技术架构师 shows that identity's capability and does not enroll anyone.
- `local-narrow` keeps the chart on the 任务 tab when the window is narrow. The list stays inside the dialog.

## How to get to it (user POV)

- Enter the studio. On a wide window, the 这台电脑 chart is the first control in the right column, above 在场.
- Choose the chart. The dialog title is 这台电脑.
- On a narrow window, choose the bottom tab `任务`, then the chart.

## Driving it with agent-browser

Preconditions:

- `verify.sh doctor` printed `doctor ok` and `WEB_URL=http://localhost:5174`.
- The session is on 大厅 as `验收员`. Follow [enter.md](./enter.md) if the gate is showing.
- The viewport is wide enough that the right column is visible. Run `agent-browser --session verify-$RUN_ID set viewport 1280 800` before looking for 这台电脑.

- **Read the closed chart.** Run `agent-browser --session verify-$RUN_ID eval 'document.querySelector("[data-testid=local-agent-list]")?.innerText ?? "absent"'`. The text is `absent`. Run `agent-browser --session verify-$RUN_ID eval 'document.querySelector("[data-testid=open-local-agents]")?.innerText ?? ""'`. The text contains `这台电脑` and `已接入`.
- **Open the dialog.** Run `agent-browser --session verify-$RUN_ID find testid open-local-agents click`. Then `agent-browser --session verify-$RUN_ID eval 'document.querySelector("[data-testid=local-agent-list]")?.innerText ?? ""'`. The text contains `Cursor`. It also contains `接入` or `已接入`.
- **Read the level.** Run `agent-browser --session verify-$RUN_ID eval 'document.querySelector("[data-testid=local-agent-level-cursor]")?.value ?? ""'`. The value is `1`.
- **Read the identity.** Run `agent-browser --session verify-$RUN_ID eval 'document.querySelector("[data-testid=local-agent-group-cursor]")?.value ?? ""'`. The value is `build`. The capability line contains `改代码`.
- **Change the identity without adding.** Run `agent-browser --session verify-$RUN_ID snapshot -i -s "[data-testid=local-agent-dialog]"`. The combobox named `Cursor 的身份` has a ref. Run `agent-browser --session verify-$RUN_ID select <that ref> "技术架构师"`. Then `agent-browser --session verify-$RUN_ID eval 'document.querySelector("[data-testid=local-agent-group-cursor]")?.value ?? ""'`. The value is `architect`. The capability line `local-agent-capability-cursor` contains `技术方案`.
- **Change the level without adding.** Run `agent-browser --session verify-$RUN_ID snapshot -i -s "[data-testid=local-agent-dialog]"`. The combobox named `Cursor 的接入等级` has a ref. Run `agent-browser --session verify-$RUN_ID select <that ref> "Lv4"`. `find testid … select` is not a valid agent-browser action. Then `agent-browser --session verify-$RUN_ID eval 'document.querySelector("[data-testid=local-agent-level-cursor]")?.value ?? ""'`. The value is `4`.
- **Do not add anyone.** Do not click any element whose testid starts with `local-agent-add-`. A click writes that client's real MCP config on this Mac and can change `data/credentials.json` for the verification server.
- **Close the dialog.** Run `agent-browser --session verify-$RUN_ID find testid local-agent-close click`. Then `agent-browser --session verify-$RUN_ID eval 'document.querySelector("[data-testid=local-agent-list]")?.innerText ?? "absent"'`. The text is `absent`.
- **Narrow window.** Run `agent-browser --session verify-$RUN_ID set viewport 390 844`, then `agent-browser --session verify-$RUN_ID find role button click --name "任务"`. Run `agent-browser --session verify-$RUN_ID eval 'document.querySelector("[data-testid=local-agent-list]")?.innerText ?? "absent"'`. The text is `absent`. Run `agent-browser --session verify-$RUN_ID find testid open-local-agents click`, then `agent-browser --session verify-$RUN_ID eval 'document.querySelector("[data-testid=local-agent-list]")?.innerText ?? ""'`. The text contains `Cursor`. Close with `local-agent-close` before leaving the page.
- **Proof.** Run `agent-browser --session verify-$RUN_ID screenshot "$EVIDENCE/local-agents/dialog.png"` while the dialog is open, and `agent-browser --session verify-$RUN_ID screenshot "$EVIDENCE/local-agents/chart.png"` after it is closed. Save the eval texts to `$EVIDENCE/local-agents/list.txt`. Do not choose 接入.

## Gotchas

- The list is computed by the API process from this Mac. A machine without Cursor will not show Cursor. Codex shows when the `codex` binary is on `PATH` or in `~/.local/bin`.
- 已接入 means that handle is already a member of this channel. A fresh verification database has only the four demo agents, so installed writable clients show 接入 and a level select. Still do not click 接入.
- Changing the level select only changes the dialog. It does not write a config and it does not enroll anyone until 接入 is chosen.
- Clicking 接入 on port 5174 writes the real home config and stores the credential against `http://127.0.0.1:8792`. That retargets a client away from the daily server.
- Below 860px the right column is hidden until the `任务` tab is chosen. The dialog is a page-level popup, so the list exists only while it is open.
- The @ menu is a different list. It shows agents already in the channel, not the apps installed on the computer.
