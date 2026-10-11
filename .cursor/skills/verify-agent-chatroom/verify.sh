#!/usr/bin/env bash
# Isolated 工位 instance for verification. Never touches localhost:5173 or 127.0.0.1:8791.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
STATE_ROOT="/tmp/agent-chatroom-verify"
CURRENT="$STATE_ROOT/current"
API_PORT=8792
WEB_PORT=5174
EVIDENCE_ROOT="/tmp/agent-chatroom-verify-evidence"

die() { printf 'verify-agent-chatroom: %s\n' "$*" >&2; exit 1; }

port_pids() {
  lsof -nP -iTCP:"$1" -sTCP:LISTEN -t 2>/dev/null || true
}

owns_port() {
  local port="$1" pid="$2" listeners listen pgid
  listeners="$(port_pids "$port")"
  [[ -n "$listeners" ]] || return 1
  for listen in $listeners; do
    [[ "$listen" == "$pid" ]] && return 0
    pgid="$(ps -o pgid= -p "$listen" 2>/dev/null | tr -d ' ')"
    [[ "$pgid" == "$pid" ]] && return 0
  done
  return 1
}

read_current() {
  [[ -f "$CURRENT" ]] || die "no verification instance. Run: $0 launch"
  # shellcheck disable=SC1090
  source "$CURRENT"
}

cmd_launch() {
  mkdir -p "$STATE_ROOT" "$EVIDENCE_ROOT"
  if [[ -f "$CURRENT" ]]; then
    # shellcheck disable=SC1090
    source "$CURRENT"
    if kill -0 "${API_PID:-0}" 2>/dev/null || kill -0 "${WEB_PID:-0}" 2>/dev/null; then
      die "instance $RUN_ID is already up at $WEB_URL. Run: $0 cleanup"
    fi
  fi
  local busy=""
  busy="$(port_pids "$API_PORT")"
  [[ -z "$busy" ]] || die "port $API_PORT is owned by pid $busy. Do not kill it from here."
  busy="$(port_pids "$WEB_PORT")"
  [[ -z "$busy" ]] || die "port $WEB_PORT is owned by pid $busy. Do not kill it from here."

  local run_id run_dir
  run_id="$(date +%Y%m%d%H%M%S)-$$"
  run_dir="$STATE_ROOT/$run_id"
  mkdir -p "$run_dir" "$EVIDENCE_ROOT/$run_id"
  local db="$run_dir/chatroom.db"
  [[ "$db" != "$ROOT/data/chatroom.db" ]] || die "refusing to use the shared database"

  python3 - "$ROOT" "$run_dir" "$db" "$API_PORT" "$WEB_PORT" <<'PY'
import os, subprocess, sys
root, run_dir, db, api_port, web_port = sys.argv[1:]
api_log = open(os.path.join(run_dir, "api.log"), "w")
api_env = os.environ.copy()
api_env["PORT"] = api_port
api_env["DATA_PATH"] = db
api = subprocess.Popen(
    [os.path.join(root, "node_modules/.bin/tsx"), "src/server/index.ts"],
    cwd=root,
    env=api_env,
    stdout=api_log,
    stderr=subprocess.STDOUT,
    start_new_session=True,
)
api_log.close()
web_log = open(os.path.join(run_dir, "web.log"), "w")
web_env = os.environ.copy()
web_env["VITE_PORT"] = web_port
web_env["AGENT_CHATROOM_API"] = f"http://127.0.0.1:{api_port}"
web = subprocess.Popen(
    [os.path.join(root, "node_modules/.bin/vite"), "--host", "localhost", "--port", web_port, "--strictPort"],
    cwd=root,
    env=web_env,
    stdout=web_log,
    stderr=subprocess.STDOUT,
    start_new_session=True,
)
web_log.close()
open(os.path.join(run_dir, "api.pid"), "w").write(str(api.pid))
open(os.path.join(run_dir, "web.pid"), "w").write(str(web.pid))
PY
  local api_pid web_pid
  api_pid="$(cat "$run_dir/api.pid")"
  web_pid="$(cat "$run_dir/web.pid")"
  local i
  for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
    if curl -fsS -m 2 "http://127.0.0.1:$API_PORT/api/health" >/dev/null 2>&1 \
      && curl -fsS -m 2 "http://localhost:$WEB_PORT/" >/dev/null 2>&1; then
      cat >"$CURRENT" <<EOF
RUN_ID=$run_id
RUN_DIR=$run_dir
WEB_URL=http://localhost:$WEB_PORT
API_URL=http://127.0.0.1:$API_PORT
DATA_PATH=$db
API_PID=$api_pid
WEB_PID=$web_pid
EVIDENCE=$EVIDENCE_ROOT/$run_id
EOF
      printf 'ready %s evidence %s\n' "http://localhost:$WEB_PORT" "$EVIDENCE_ROOT/$run_id"
      return 0
    fi
    if ! kill -0 "$api_pid" 2>/dev/null || ! kill -0 "$web_pid" 2>/dev/null; then
      printf 'api log:\n' >&2
      tail -30 "$run_dir/api.log" >&2 || true
      printf 'web log:\n' >&2
      tail -30 "$run_dir/web.log" >&2 || true
      die "instance exited before it was ready"
    fi
    sleep 0.5
  done
  die "timed out waiting for $API_PORT and $WEB_PORT"
}

cmd_doctor() {
  read_current
  kill -0 "$API_PID" 2>/dev/null || die "api pid $API_PID is dead"
  kill -0 "$WEB_PID" 2>/dev/null || die "web pid $WEB_PID is dead"
  owns_port "$API_PORT" "$API_PID" || die "port $API_PORT is not held by api pid $API_PID"
  owns_port "$WEB_PORT" "$WEB_PID" || die "port $WEB_PORT is not held by web pid $WEB_PID"
  [[ "$DATA_PATH" == /tmp/agent-chatroom-verify/* ]] || die "data path $DATA_PATH is not a disposable verification database"
  [[ "$DATA_PATH" != "$ROOT/data/chatroom.db" ]] || die "refusing the shared database"
  [[ "$WEB_URL" == "http://localhost:$WEB_PORT" ]] || die "web url $WEB_URL is not the verification port"
  local health html
  health="$(curl -fsS -m 2 "$API_URL/api/health")"
  [[ "$health" == *'"ok":true'* ]] || die "health was $health"
  html="$(curl -fsS -m 2 "$WEB_URL/")"
  [[ "$html" == *工位* ]] || die "page at $WEB_URL did not contain 工位"
  printf 'doctor ok run=%s web=%s api=%s data=%s evidence=%s\n' "$RUN_ID" "$WEB_URL" "$API_URL" "$DATA_PATH" "$EVIDENCE"
}

stop_pid() {
  local pid="$1"
  kill -0 "$pid" 2>/dev/null || return 0
  kill -TERM -"$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
  local i
  for i in 1 2 3 4 5 6 7 8 9 10; do
    kill -0 "$pid" 2>/dev/null || return 0
    sleep 0.2
  done
  kill -KILL -"$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null || true
}

cmd_cleanup() {
  [[ -f "$CURRENT" ]] || { printf 'nothing to clean\n'; return 0; }
  # shellcheck disable=SC1090
  source "$CURRENT"
  stop_pid "${WEB_PID:-0}"
  stop_pid "${API_PID:-0}"
  if [[ -n "${RUN_DIR:-}" && "$RUN_DIR" == /tmp/agent-chatroom-verify/* ]]; then
    rm -rf "$RUN_DIR"
  fi
  rm -f "$CURRENT"
  printf 'cleaned run=%s evidence kept at %s\n' "${RUN_ID:-unknown}" "${EVIDENCE:-$EVIDENCE_ROOT}"
}

usage() {
  cat <<EOF
Usage: $0 launch|doctor|cleanup
EOF
}

case "${1:-}" in
  launch) cmd_launch ;;
  doctor) cmd_doctor ;;
  cleanup) cmd_cleanup ;;
  *) usage; exit 2 ;;
esac
