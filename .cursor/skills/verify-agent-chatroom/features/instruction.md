# Post an instruction

Post an instruction lets a person write a demand in the message box and send it as 下指令. The demand shows in the transcript and as a card under 任务. Demo agents may bid after it is sent. This recipe only proves the demand was recorded.

## Sub-features

- `instruction-compose` keeps 下指令 selected and enables 发送 once the box is non-empty.
- `instruction-send` puts the demand in the transcript and the task list.
- `instruction-stored` writes the same body to the disposable database.

## How to get to it (user POV)

- Enter the studio and stay on 大厅.
- Leave the kind on `下指令`.
- Type the demand and choose `发送`.
- Read the transcript and the 任务 list. On a narrow window, 任务 is the bottom tab.

## Driving it with agent-browser

Preconditions:

- `verify.sh doctor` printed `doctor ok`.
- The session is on 大厅 as `验收员`. Follow [enter.md](./enter.md) if the gate is showing.
- The demand text `给验收按钮一个禁用态` is not already in this database.

- **Select the kind.** Run `agent-browser --session verify-$RUN_ID snapshot -i`. The radio `下指令` is checked. If it is not, run `agent-browser --session verify-$RUN_ID find testid kind-instruction click`.
- **Write the demand.** Run `agent-browser --session verify-$RUN_ID find testid composer fill "给验收按钮一个禁用态"`. The button `发送` is enabled.
- **Send.** Run `agent-browser --session verify-$RUN_ID find testid send click` and `agent-browser --session verify-$RUN_ID snapshot -i`. The snapshot contains `给验收按钮一个禁用态` in the transcript and in the task list.
- **Confirm the rows.** Run `sqlite3 "$DATA_PATH" "SELECT body FROM messages WHERE body LIKE '%给验收按钮一个禁用态%';"` and `sqlite3 "$DATA_PATH" "SELECT title FROM tasks WHERE title LIKE '%给验收按钮一个禁用态%';"`. Each stdout contains that sentence.
- **Proof.** Run `agent-browser --session verify-$RUN_ID snapshot -i > "$EVIDENCE/instruction/sent.snapshot.txt"` and `agent-browser --session verify-$RUN_ID screenshot "$EVIDENCE/instruction/sent.png"`.

## Gotchas

- Demo agents are running in this instance. The card can leave 待认领 within a few seconds. Assert the title text, not a status word.
- The four demo agents are 实现、评审、测试. They do not open the design gate. If the room also has an unpaused 课题研究、产品设计师、设计师、or 技术架构师 and the tag box is empty, the card stays on 出方案 until that identity submits or a person clicks 交给实现.
- Enter in the message box sends. Shift is not held by `agent-browser press Enter`. Prefer the `发送` button.
- Do not post this demand to the daily 大厅. Doctor's `DATA_PATH` is the only database to query.
- 大厅 shows a note that it has no working directory. That note is expected and is not a failed send.
