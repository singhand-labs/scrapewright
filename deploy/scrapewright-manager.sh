#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CONFIG_FILE="$SCRIPT_DIR/config.yaml"

# Parse simple yaml values (no nested structures)
parse_yaml_value() {
  grep "^$1:" "$CONFIG_FILE" | head -1 | sed "s/^$1:[[:space:]]*//" | tr -d '"' | tr -d "'"
}

BASE_PORT=$(parse_yaml_value basePort)
BASE_DEBUG_PORT=$(parse_yaml_value baseDebugPort)
INSTANCES=$(parse_yaml_value instances)
EXTENSION_PATH=$(parse_yaml_value extensionPath)
NATIVE_HOST_PATH=$(parse_yaml_value nativeHostPath)
PROFILE_BASE=$(parse_yaml_value profileBaseDir)
HEADLESS=$(parse_yaml_value headless)

# Resolve relative paths
[[ "$EXTENSION_PATH" != /* ]] && EXTENSION_PATH="$SCRIPT_DIR/$EXTENSION_PATH"
[[ "$NATIVE_HOST_PATH" != /* ]] && NATIVE_HOST_PATH="$SCRIPT_DIR/$NATIVE_HOST_PATH"
[[ "$PROFILE_BASE" != /* ]] && PROFILE_BASE="$SCRIPT_DIR/$PROFILE_BASE"

resolve_chrome() {
  if command -v google-chrome-stable &>/dev/null; then
    echo "google-chrome-stable"
  elif command -v google-chrome &>/dev/null; then
    echo "google-chrome"
  elif [[ -f "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" ]]; then
    echo "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
  elif [[ -n "${CHROME_PATH:-}" ]]; then
    echo "$CHROME_PATH"
  else
    echo "ERROR: Chrome not found. Set CHROME_PATH environment variable." >&2
    exit 1
  fi
}

CHROME=$(resolve_chrome)

start_instance() {
  local id=$1
  local port=$((BASE_PORT + id))
  local debug_port=$((BASE_DEBUG_PORT + id))
  local profile_dir="$PROFILE_BASE/profile-$id"

  mkdir -p "$profile_dir"

  # Check if already running
  if [[ -f "$profile_dir/host.pid" ]] && kill -0 "$(cat "$profile_dir/host.pid")" 2>/dev/null; then
    echo "Instance $id already running (port $port)"
    return 0
  fi

  # Start host.js
  SCRAPEWRIGHT_PORT=$port node "$NATIVE_HOST_PATH/host.js" > "$profile_dir/host.log" 2>&1 &
  local host_pid=$!
  echo "$host_pid" > "$profile_dir/host.pid"

  # Brief delay for host to start
  sleep 1

  # Build Chrome args
  local chrome_args=(
    "--user-data-dir=$profile_dir"
    --no-first-run
    --disable-default-apps
    --disable-background-networking
    "--load-extension=$EXTENSION_PATH"
    "--remote-debugging-port=$debug_port"
  )

  if [[ "$HEADLESS" == "true" ]]; then
    chrome_args+=(--headless=new)
  fi

  # Start Chrome
  "$CHROME" "${chrome_args[@]}" > "$profile_dir/chrome.log" 2>&1 &
  local chrome_pid=$!
  echo "$chrome_pid" > "$profile_dir/chrome.pid"

  echo "Instance $id started (port=$port, debug=$debug_port, host_pid=$host_pid, chrome_pid=$chrome_pid)"
}

stop_instance() {
  local id=$1
  local profile_dir="$PROFILE_BASE/profile-$id"

  for pid_file in "$profile_dir/host.pid" "$profile_dir/chrome.pid"; do
    if [[ -f "$pid_file" ]]; then
      local pid=$(cat "$pid_file")
      if kill -0 "$pid" 2>/dev/null; then
        kill "$pid" 2>/dev/null || true
      fi
      rm -f "$pid_file"
    fi
  done
  echo "Instance $id stopped"
}

status_instance() {
  local id=$1
  local port=$((BASE_PORT + id))
  local profile_dir="$PROFILE_BASE/profile-$id"

  local host_alive="stopped"
  local chrome_alive="stopped"
  local health=""

  if [[ -f "$profile_dir/host.pid" ]] && kill -0 "$(cat "$profile_dir/host.pid")" 2>/dev/null; then
    host_alive="running"
    health=$(curl -s "http://localhost:$port/health" 2>/dev/null || echo '{"status":"unreachable"}')
  fi

  if [[ -f "$profile_dir/chrome.pid" ]] && kill -0 "$(cat "$profile_dir/chrome.pid")" 2>/dev/null; then
    chrome_alive="running"
  fi

  echo "Instance $id: host=$host_alive chrome=$chrome_alive port=$port health=$health"
}

cmd_start() {
  local count=${1:-$INSTANCES}
  echo "Starting $count instances..."
  for i in $(seq 0 $((count - 1))); do
    start_instance $i
  done
}

cmd_stop() {
  local count=${1:-$INSTANCES}
  echo "Stopping $count instances..."
  for i in $(seq 0 $((count - 1))); do
    stop_instance $i
  done
}

cmd_status() {
  local count=${1:-$INSTANCES}
  for i in $(seq 0 $((count - 1))); do
    status_instance $i
  done
}

cmd_restart() {
  local id=${1:-0}
  stop_instance $id
  sleep 2
  start_instance $id
}

case "${1:-status}" in
  start)  cmd_start "${2:-}" ;;
  stop)   cmd_stop "${2:-}" ;;
  status) cmd_status ;;
  restart) cmd_restart "${2:-}" ;;
  *)      echo "Usage: $0 {start|stop|status|restart} [count|id]" ;;
esac
