#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNTIME_DIR="$ROOT_DIR/.runtime/dev"
PID_FILE="$RUNTIME_DIR/we-claw.pid"
HTTP_PORT="${WE_CLAW_HTTP_PORT:-4173}"

is_pid_running() {
  local pid="$1"
  [[ -n "$pid" ]] && kill -0 "$pid" >/dev/null 2>&1
}

pid_belongs_to_we_claw() {
  local pid="$1"
  local command_line
  command_line="$(ps -p "$pid" -o command= 2>/dev/null || true)"
  [[ "$command_line" == *"dist/src/launcher/cli.js"* || "$command_line" == *"$ROOT_DIR"* ]]
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

stop_port_listener_if_safe() {
  if ! command -v lsof >/dev/null 2>&1; then
    return 1
  fi

  local pids
  pids="$(lsof -tiTCP:"$HTTP_PORT" -sTCP:LISTEN || true)"
  if [[ -z "$pids" ]]; then
    return 1
  fi

  local stopped="0"
  for pid in $pids; do
    if pid_belongs_to_we_claw "$pid"; then
      stop_pid_tree "$pid"
      stopped="1"
    else
      printf 'Port %s has a listener with PID %s, but it does not look like this We-Claw server. Leaving it running.\n' "$HTTP_PORT" "$pid"
    fi
  done

  [[ "$stopped" == "1" ]]
}

if [[ ! -f "$PID_FILE" ]]; then
  if stop_port_listener_if_safe; then
    printf 'We-Claw listener on port %s stopped.\n' "$HTTP_PORT"
    exit 0
  fi

  printf 'We-Claw is not running.\n'
  exit 0
fi

PID="$(<"$PID_FILE")"

if ! is_pid_running "$PID"; then
  rm -f "$PID_FILE"
  if stop_port_listener_if_safe; then
    printf 'We-Claw listener on port %s stopped.\n' "$HTTP_PORT"
    exit 0
  fi

  printf 'We-Claw pid file was stale and has been removed.\n'
  exit 0
fi

stop_pid_tree "$PID"
rm -f "$PID_FILE"

if stop_port_listener_if_safe >/dev/null 2>&1; then
  :
fi

printf 'We-Claw stopped.\n'
