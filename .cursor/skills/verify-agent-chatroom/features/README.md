# 工位 verification map

This directory is the maintained source for verifying the user-facing behavior of 工位 (agent-chatroom). Read the index before driving the app, then use the matching feature file as the recipe.

## Baseline preconditions

- Launch with `.cursor/skills/verify-agent-chatroom/verify.sh launch`.
- The page is `http://localhost:5174`. The API is `http://127.0.0.1:8792`. The database is a new file under `/tmp/agent-chatroom-verify/<run-id>/`.
- Run `.cursor/skills/verify-agent-chatroom/verify.sh doctor` and require `doctor ok` before any browser command.
- Never open `http://localhost:5173` or `http://127.0.0.1:8791` for a proof. Those belong to the daily instance and its `data/chatroom.db`.
- Set `AGENT_BROWSER_EXECUTABLE_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"`.
- Use `agent-browser --session verify-<run-id>` so the drive cannot reuse a window that was on the daily instance.

## Driving conventions

- Start every recipe from the gate (no display name entered) unless its preconditions say otherwise.
- Prefer `data-testid` and accessible names over CSS structure or screen coordinates.
- Treat every command as literal. Keep quoted Chinese labels unchanged.
- Passing `--` is required before an `agent-browser eval` script when the script starts with a quote or a brace is unnecessary; pass the script with `--stdin` when it is more than one line.
- Do not remove proof artifacts during cleanup.

## Proof and skip reporting

- Capture the user action and the resulting state, not only the final screen.
- UI proof includes an interactive snapshot and a screenshot that shows 工位.
- Mutation proof includes a read-only sqlite query against the disposable `DATA_PATH`.
- Record the feature id and the entry point with every artifact.
- Report an unreachable path with the attempted command and the unmet precondition.
- Do not report a skipped entry point as verified through a different path.

## Feature entry contract

Each feature file starts with an H1 title and one paragraph describing the user-visible behavior. It then uses exactly four H2 sections in this order.

1. `Sub-features` lists short IDs with one line for each behavior.
2. `How to get to it (user POV)` lists every user entry point.
3. `Driving it with agent-browser` starts with `Preconditions:` and uses labeled bullets that pair each user action with an exact command and observable result.
4. `Gotchas` lists traps that can waste or invalidate a verification run.

## Features

- [Enter the studio](./enter.md) covers the name gate, landing in 大厅, and the disposable user row.
- [Mention an agent](./mention.md) covers typing `@`, the suggestion list, inserting a handle, and the wake hint.
- [Post an instruction](./instruction.md) covers sending a 下指令 message and seeing it on the task list.
- [See who is here](./roster.md) covers the 在场 list grouped by person, the live duty under each agent, and opening @ from a handle.
- [Local coding agents](./local-agents.md) covers the 这台电脑 chart and its dialog of installed apps. Do not click 接入 during a proof.
- [Stop an agent](./stop.md) covers the 停止 button on an 在场 row.
