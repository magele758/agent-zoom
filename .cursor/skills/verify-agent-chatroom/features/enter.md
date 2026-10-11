# Enter the studio

Enter the studio lets a person type a display name, open 工作室, and land in 大厅. The same name on this database returns to the same studio. A brand-new database creates the studio on the first enter.

## Sub-features

- `enter-gate` shows the name field before anyone is in a room.
- `enter-submit` opens 大厅 for that display name.
- `enter-persist` stores the display name in the disposable database.

## How to get to it (user POV)

- Open the verification page. The first screen is the gate.
- Type a name in `你的名字` and choose `进入工作室`.

## Driving it with agent-browser

Preconditions:

- `verify.sh doctor` printed `doctor ok` and `WEB_URL=http://localhost:5174`.
- The browser session has not entered a name yet.
- `DATA_PATH` from doctor is the sqlite file you will query.

- **Open the gate.** Run `agent-browser --session verify-$RUN_ID open http://localhost:5174/` and `agent-browser --session verify-$RUN_ID snapshot -i`. The snapshot contains a textbox named `你的名字` and a disabled button `进入工作室`.
- **Type a name.** Run `agent-browser --session verify-$RUN_ID find testid name-input fill "验收员"`. The button `进入工作室` is enabled.
- **Enter.** Run `agent-browser --session verify-$RUN_ID find testid enter click` and `agent-browser --session verify-$RUN_ID snapshot -i`. The snapshot contains a button named `大厅` and does not contain the textbox `你的名字`.
- **Confirm the row.** Run `sqlite3 "$DATA_PATH" "SELECT name FROM users;"`. Stdout is `验收员`.
- **Proof.** Run `agent-browser --session verify-$RUN_ID snapshot -i > "$EVIDENCE/enter/room.snapshot.txt"` and `agent-browser --session verify-$RUN_ID screenshot "$EVIDENCE/enter/room.png"`. The snapshot file contains `大厅` and `验收员`.

## Gotchas

- `http://127.0.0.1:5174` is not the Vite site. Use `http://localhost:5174`.
- The same display name joins the existing studio inside this database. On a fresh verification database the first enter creates 工作室 and 大厅.
- Do not enter the name `彭磊` on the daily database. This recipe is only valid against `DATA_PATH` from doctor.
- The header chip reads `你是 验收员` after enter. The gate textbox is gone; do not look for `name-input` on 大厅.
