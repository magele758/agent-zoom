---
name: verify-agent-chatroom
description: Drive the local 工位 web app (agent-chatroom) the way a person does and prove a change. Use when a change touches the chat UI, composer, @ mentions, roster, instructions, or the local API, and the proof has to be a real browser session against a disposable database.
---

# Verify 工位

工位 is a local web app. People use the page at the Vite URL. The API is a separate process. Verification always starts its own pair on ports **5174** and **8792** with a database under `/tmp/agent-chatroom-verify/`. The daily instance on `http://localhost:5173` and `http://127.0.0.1:8791`, and the file `data/chatroom.db`, belong to the person using the app. Do not open them, restart them, or kill them.

The helper is `.cursor/skills/verify-agent-chatroom/verify.sh`. Run it from anywhere.

## Launch

```bash
.cursor/skills/verify-agent-chatroom/verify.sh launch
```

Ready when the command prints `ready http://localhost:5174 evidence /tmp/agent-chatroom-verify-evidence/<run-id>`. The API log line `工位服务 http://127.0.0.1:8792` is in `/tmp/agent-chatroom-verify/<run-id>/api.log`. The page is ready when `http://localhost:5174/` returns HTML containing `工位`.

`launch` refuses to start when 8792 or 5174 is already taken, and it refuses when a previous verification instance is still alive. It does not free those ports by killing whoever owns them.

Chrome for the browser harness:

```bash
export AGENT_BROWSER_EXECUTABLE_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
```

Use a fresh `agent-browser --session` name that includes the `RUN_ID` from doctor. Do not reuse a session that was pointed at port 5173.

## Doctor

Run this before every drive, and again whenever the page looks like the wrong studio:

```bash
.cursor/skills/verify-agent-chatroom/verify.sh doctor
```

It passes only when all of these are true:

- The API and Vite pids recorded at launch are alive.
- `127.0.0.1:8792` and `localhost:5174` are held by those pids.
- `DATA_PATH` is under `/tmp/agent-chatroom-verify/` and is not `data/chatroom.db`.
- `GET /api/health` on the verification API returns `{"ok":true}`.
- The verification page HTML contains `工位`.

If doctor fails, stop. Do not point the browser at `localhost:5173`.

## Drive

Read `.cursor/skills/verify-agent-chatroom/features/README.md`, then the feature file for the behavior under test. Drive the page with `agent-browser` against `WEB_URL` from doctor (`http://localhost:5174`).

Stable handles are `data-testid` values and the accessible names in the feature files. Prefer `agent-browser find testid <id>`. Do not click by screen coordinates.

A second view of server state is the disposable sqlite file printed as `data=` by doctor:

```bash
sqlite3 "$DATA_PATH" "SELECT name FROM users;"
```

Login is get-or-create by display name inside that database only. The first name creates 工作室 and 大厅 plus four demo agents: `builder`, `maker`, `reviewer`, `qa`.

## Evidence

Write proof under the `EVIDENCE` directory doctor prints. Cleanup must not delete it.

For a UI proof, save both:

- an `agent-browser snapshot -i` transcript taken after the action
- a screenshot taken while the resulting state is on screen

Also record the side effect that is not just the last paint: for entering, the display name row in `users`; for a sent message, the `messages.body` and `tasks.title` rows. A menu that is only open in the browser is proved by the snapshot of `#mention-menu` plus the screenshot. Do not call an internal setter or a test-only route. There is no test-only route.

Name files with the feature id, for example `$EVIDENCE/mention/menu.snapshot.txt` and `$EVIDENCE/mention/menu.png`.

## Cleanup

```bash
.cursor/skills/verify-agent-chatroom/verify.sh cleanup
```

This sends `SIGTERM` to the process groups started by `launch`, then removes `/tmp/agent-chatroom-verify/<run-id>/` and `/tmp/agent-chatroom-verify/current`. It leaves `/tmp/agent-chatroom-verify-evidence/<run-id>/` in place. Close the browser session you opened (`agent-browser --session <name> close`). If that close hangs, stop that session's process; do not kill Chrome by name, and do not kill whatever is listening on 5173 or 8791.

After cleanup, doctor must fail because `current` is gone, and the evidence files must still be readable.

## Helpers

`verify.sh` is the only helper. It is executable.

```bash
.cursor/skills/verify-agent-chatroom/verify.sh launch
.cursor/skills/verify-agent-chatroom/verify.sh doctor
.cursor/skills/verify-agent-chatroom/verify.sh cleanup
```

Browser commands stay in the feature files. They are `agent-browser` itself, not a wrapper.
