# Mention an agent

Mention an agent lets a person type `@` in the message box and pick a handle from the people in this channel. Choosing one inserts `@handle` and the line under the box says who will be woken. Nothing is sent until they choose `发送`.

## Sub-features

- `mention-open` lists channel agents when the box contains a trailing `@`.
- `mention-filter` narrows that list as more letters are typed.
- `mention-insert` writes the chosen `@handle` and a wake line.
- `mention-miss` says a finished handle is not in the channel.

## How to get to it (user POV)

- Enter the studio, stay on 大厅, and click the message box.
- Type `@`.
- Choose a row in the list, or press Enter while a row is highlighted.
- On a narrow window the list still opens above the message box. The 在场 list itself is on the 任务 tab.

## Driving it with agent-browser

Preconditions:

- `verify.sh doctor` printed `doctor ok`.
- The session is on 大厅. If the gate is showing, follow [enter.md](./enter.md) first with the name `验收员`.
- The kind `下指令` may stay selected. The list opens for 下指令, 发言, and 提问.

- **Open the list.** Run `agent-browser --session verify-$RUN_ID find testid composer fill "@"`. Then `agent-browser --session verify-$RUN_ID eval 'document.querySelector("#mention-menu")?.innerText ?? ""'`. The text contains `@builder`, `@maker`, `@qa`, and `@reviewer`.
- **Filter.** Run `agent-browser --session verify-$RUN_ID find testid composer fill "@bu"`. The menu text contains `@builder` and does not contain `@qa`.
- **Insert.** Run `agent-browser --session verify-$RUN_ID find testid mention-option-builder click`. Then `agent-browser --session verify-$RUN_ID eval 'JSON.stringify({value: document.querySelector("#composer")?.value, hint: document.querySelector("[data-testid=mention-hint]")?.innerText ?? ""})'`. The value is `@builder ` and the hint contains `将叫醒` and `@builder`.
- **Unknown handle.** Run `agent-browser --session verify-$RUN_ID find testid composer fill "@builder @nope "`. The hint contains `@nope` and `不在这个频道`.
- **Proof.** Restore the open list with `agent-browser --session verify-$RUN_ID find testid composer fill "@"`, then `agent-browser --session verify-$RUN_ID snapshot -i > "$EVIDENCE/mention/menu.snapshot.txt"` and `agent-browser --session verify-$RUN_ID screenshot "$EVIDENCE/mention/menu.png"`. The snapshot contains `@builder`. Do not choose `发送`.

## Gotchas

- `agent-browser type "@"` is parsed as a ref and does not type the character. Use `find testid composer fill`.
- Enter while the list is open inserts the highlighted handle. It does not send. Esc closes the list and leaves the typed `@`.
- Demo agents are the only handles on a fresh database. `cursor` and `chatgpt` appear only in the daily database, which this run must not open.
- A handle counts as finished when it is no longer the token under the caret. `@builder ` with the trailing space produces the wake line. `@bu` is still a filter.
- The list does not send an inbox row. Sending would. This recipe stops before `发送`.
