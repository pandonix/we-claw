#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNTIME_DIR="$ROOT_DIR/.runtime/dev"
PID_FILE="$RUNTIME_DIR/we-claw.pid"
LOG_FILE="$RUNTIME_DIR/we-claw.log"

HOST="127.0.0.1"
HTTP_PORT="${WE_CLAW_HTTP_PORT:-4173}"
URL="http://${HOST}:${HTTP_PORT}"
ENTRYPOINT="$ROOT_DIR/dist/src/launcher/cli.js"

SERVER_PID=""
STARTUP_COMPLETE="0"

require_command() {
  local cmd="$1"
  local hint="$2"
  if ! command -v "$cmd" >/dev/null 2>&1; then
    printf 'Missing required command: %s\n%s\n' "$cmd" "$hint" >&2
    exit 1
  fi
}

spawn_detached() {
  local workdir="$1"
  local log_file="$2"
  shift 2

  python3 - "$workdir" "$log_file" "$@" <<'PY'
import os
import sys

workdir = sys.argv[1]
log_file = sys.argv[2]
cmd = sys.argv[3:]

pid = os.fork()
if pid > 0:
    print(pid)
    sys.exit(0)

os.setsid()
os.chdir(workdir)

devnull_fd = os.open("/dev/null", os.O_RDONLY)
log_fd = os.open(log_file, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o644)

os.dup2(devnull_fd, 0)
os.dup2(log_fd, 1)
os.dup2(log_fd, 2)

os.close(devnull_fd)
os.close(log_fd)

os.execvpe(cmd[0], cmd, os.environ.copy())
PY
}

is_pid_running() {
  local pid="$1"
  [[ -n "$pid" ]] && kill -0 "$pid" >/dev/null 2>&1
}

clear_stale_pid_file() {
  if [[ ! -f "$PID_FILE" ]]; then
    return 0
  fi

  local pid
  pid="$(<"$PID_FILE")"
  if is_pid_running "$pid"; then
    printf 'We-Claw is already running with PID %s. Use ./stop.sh first if you need to restart it.\n' "$pid" >&2
    exit 1
  fi

  rm -f "$PID_FILE"
}

require_free_port() {
  if lsof -nP -iTCP:"$HTTP_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
    printf 'Port %s is already in use. Stop the existing listener or set WE_CLAW_HTTP_PORT before running ./start.sh.\n' "$HTTP_PORT" >&2
    exit 1
  fi
}

wait_for_url() {
  local url="$1"
  local retries="${2:-60}"

  if ! command -v curl >/dev/null 2>&1; then
    return 0
  fi

  for ((i = 1; i <= retries; i++)); do
    if curl --silent --fail --max-time 1 "$url" >/dev/null 2>&1; then
      return 0
    fi

    if ! is_pid_running "$SERVER_PID"; then
      printf 'We-Claw exited before becoming ready. Check %s.\n' "$LOG_FILE" >&2
      return 1
    fi

    sleep 1
  done

  printf 'Timed out waiting for We-Claw at %s. Check %s.\n' "$url" "$LOG_FILE" >&2
  return 1
}

stop_pid_tree() {
  local pid="$1"
  if ! is_pid_running "$pid"; then
    return 0
  fi

  local children
  children="$(pgrep -P "$pid" || true)"
  for child in $children; do
    stop_pid_tree "$child"
  done

  kill "$pid" >/dev/null 2>&1 || true

  for _ in {1..20}; do
    if ! is_pid_running "$pid"; then
      return 0
    fi
    sleep 0.5
  done

  kill -9 "$pid" >/dev/null 2>&1 || true
}

cleanup_on_error() {
  local exit_code=$?
  if [[ "$STARTUP_COMPLETE" == "1" ]]; then
    exit "$exit_code"
  fi

  if [[ -n "$SERVER_PID" ]]; then
    stop_pid_tree "$SERVER_PID"
  fi

  rm -f "$PID_FILE"
  exit "$exit_code"
}
trap cleanup_on_error EXIT INT TERM

require_command "node" "Install Node.js 22.12 or newer, then rerun ./start.sh."
require_command "npm" "Install npm, then rerun ./start.sh."
require_command "python3" "Install Python 3 first, then rerun ./start.sh."
require_command "lsof" "Install lsof first, or manually confirm the HTTP port is free."
require_command "pgrep" "Install pgrep first, then rerun ./start.sh."

mkdir -p "$RUNTIME_DIR"
clear_stale_pid_file

NODE_COMPATIBLE="$(node -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.stdout.write(major > 22 || (major === 22 && minor >= 12) ? "1" : "0")')"
if [[ "$NODE_COMPATIBLE" != "1" ]]; then
  printf 'Node.js 22.12 or newer is required. Current version: %s\n' "$(node -v)" >&2
  exit 1
fi

if [[ ! -d "$ROOT_DIR/node_modules" ]]; then
  printf 'Dependencies are not installed.\nRun:\n  cd %s && npm install\nThen rerun ./start.sh.\n' "$ROOT_DIR" >&2
  exit 1
fi

if [[ ! -f "$ENTRYPOINT" || "${WE_CLAW_BUILD:-1}" == "1" ]]; then
  (cd "$ROOT_DIR" && npm run build)
fi

if [[ ! -f "$ENTRYPOINT" ]]; then
  printf 'Built launcher entrypoint is missing: %s\n' "$ENTRYPOINT" >&2
  exit 1
fi

require_free_port

SERVER_PID="$(spawn_detached "$ROOT_DIR" "$LOG_FILE" node "$ENTRYPOINT" start)"
printf '%s\n' "$SERVER_PID" > "$PID_FILE"

wait_for_url "$URL/api/bootstrap"

STARTUP_COMPLETE="1"

printf 'We-Claw started: %s\n' "$URL"
printf 'Log: %s\n' "$LOG_FILE"
printf 'Stop it with ./stop.sh\n'
