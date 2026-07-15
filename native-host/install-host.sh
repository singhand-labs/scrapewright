#!/bin/bash
# Scrapewright native messaging host installer + diagnostics.
#
# Usage:
#   ./install-host.sh <extension-id>     Install (or reinstall) the host manifest.
#   ./install-host.sh --doctor           Run diagnostics without modifying anything.
#   ./install-host.sh --uninstall        Remove the manifest and wrapper.
#
# The installer generates a host-launcher.sh wrapper next to host.js. The
# wrapper hard-codes the absolute path to node detected at install time,
# so Chrome can launch the host even though its PATH doesn't include
# Homebrew/nvm locations (the #1 Mac native-messaging failure mode).

set -e

HOST_DIR="$(cd "$(dirname "$0")" && pwd)"
HOST_NAME="com.scrapewright.host"
NODE_MIN_MAJOR=18

if [[ "$OSTYPE" == "darwin"* ]]; then
  MANIFEST_DIR="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
  DEFAULT_LOG_FILE="$HOME/Library/Logs/scrapewright/host.log"
else
  MANIFEST_DIR="$HOME/.config/google-chrome/NativeMessagingHosts"
  DEFAULT_LOG_FILE="${XDG_CACHE_HOME:-$HOME/.cache}/scrapewright/host.log"
fi

MANIFEST_PATH="$MANIFEST_DIR/$HOST_NAME.json"
LAUNCHER_PATH="$HOST_DIR/host-launcher.sh"

# --- helpers -----------------------------------------------------------------

c_red()   { printf '\033[31m%s\033[0m' "$1"; }
c_green() { printf '\033[32m%s\033[0m' "$1"; }
c_yellow(){ printf '\033[33m%s\033[0m' "$1"; }
c_dim()   { printf '\033[2m%s\033[0m' "$1"; }

say()   { echo "$@"; }
info()  { echo "  $(c_dim '→') $*"; }
ok()    { echo "  $(c_green '✓') $*"; }
warn()  { echo "  $(c_yellow '!') $*"; }
fail()  { echo "  $(c_red '✗') $*" >&2; }

# Returns absolute path to node binary, or empty if not found.
detect_node() {
  local p
  p="$(command -v node 2>/dev/null || true)"
  if [[ -n "$p" ]]; then
    # Resolve symlinks (Homebrew, nvm, asdf all symlink node).
    if command -v realpath >/dev/null 2>&1; then
      realpath "$p"
    else
      # readlink -f is GNU; macOS readlink lacks -f until newer releases.
      # Fall back to the path as-is (still works for the wrapper).
      echo "$p"
    fi
    return 0
  fi
  return 1
}

check_node_version() {
  local node_bin="$1"
  local ver
  ver="$("$node_bin" --version | sed 's/^v//')"
  local major="${ver%%.*}"
  if [[ "$major" -lt "$NODE_MIN_MAJOR" ]]; then
    return 1
  fi
  echo "$ver"
}

# --- doctor ------------------------------------------------------------------

run_doctor() {
  say "Scrapewright native host doctor"
  say ""
  say "$(c_dim 'Environment')"
  info "OS: $OSTYPE"
  info "Host dir: $HOST_DIR"
  info "Manifest path: $MANIFEST_PATH"
  info "Wrapper path: $LAUNCHER_PATH"
  info "Default log file: $DEFAULT_LOG_FILE"
  echo

  say "$(c_dim 'Node.js')"
  local node_bin
  if node_bin="$(detect_node)"; then
    ok "node found: $node_bin"
    local ver
    if ver="$(check_node_version "$node_bin" 2>/dev/null)"; then
      ok "node version $ver (≥ $NODE_MIN_MAJOR)"
    else
      ver="$("$node_bin" --version 2>/dev/null || echo unknown)"
      fail "node version $ver — need ≥ $NODE_MIN_MAJOR"
    fi
  else
    fail "node not on PATH"
    warn "install Node.js $NODE_MIN_MAJOR+ from https://nodejs.org/ or: brew install node"
    return 1
  fi
  echo

  say "$(c_dim 'Manifest')"
  if [[ -f "$MANIFEST_PATH" ]]; then
    ok "manifest exists"
    info "contents:"
    sed 's/^/      /' "$MANIFEST_PATH"
    echo

    # Validate manifest shape using node itself (it's available).
    # The drift check compares the manifest's path parent dir against the
    # current script dir (both realpath-resolved). When they differ, Chrome
    # launches a wrapper from a stale/different project copy — the classic
    # "moved the project dir, native messaging silently broke" failure.
    if "$node_bin" -e '
      const fs = require("fs"), path = require("path");
      const manifestPath = process.argv[1];
      const currentLauncher = process.argv[2];
      let m;
      try { m = JSON.parse(fs.readFileSync(manifestPath, "utf8")); }
      catch (e) { console.error("      " + e.message); process.exit(1); }
      const resolve = (p) => { try { return fs.realpathSync(p); } catch { return null; } };
      const manifestDir = m.path ? resolve(path.dirname(m.path)) : null;
      const currentDir  = resolve(path.dirname(currentLauncher));
      const driftOk = !!manifestDir && !!currentDir && manifestDir === currentDir;
      const checks = [
        ["name present", !!m.name],
        ["path present", !!m.path],
        ["path exists on disk", m.path && fs.existsSync(m.path)],
        ["path is executable", m.path && fs.existsSync(m.path) && (fs.statSync(m.path).mode & 0o111) !== 0],
        ["path points into current host dir", driftOk],
        ["type=stdio", m.type === "stdio"],
        ["allowed_origins non-empty", Array.isArray(m.allowed_origins) && m.allowed_origins.length > 0],
      ];
      let allOk = true;
      for (const [label, ok] of checks) {
        console.log("      " + (ok ? "✓" : "✗") + " " + label);
        if (!ok) allOk = false;
      }
      if (!driftOk && m.path) {
        console.error("      manifest path dir : " + (manifestDir || "(unresolvable)"));
        console.error("      current host dir  : " + (currentDir || "(unresolvable)"));
        console.error("      → re-install to fix: ./install-host.sh <extension-id>");
      }
      process.exit(allOk ? 0 : 1);
    ' "$MANIFEST_PATH" "$LAUNCHER_PATH"; then
      :
    else
      fail "manifest validation reported problems"
    fi
  else
    fail "manifest not installed"
    warn "run: ./install-host.sh <extension-id>"
  fi
  echo

  say "$(c_dim 'Port 8765')"
  if command -v lsof >/dev/null 2>&1; then
    if lsof -i :8765 -sTCP:LISTEN >/dev/null 2>&1; then
      warn "port 8765 is in use:"
      lsof -i :8765 -sTCP:LISTEN 2>/dev/null | sed 's/^/      /' | head -3
    else
      ok "port 8765 is free"
    fi
  else
    info "lsof unavailable — skipping port check"
  fi
  echo

  say "$(c_dim 'Recent log')"
  if [[ -f "$DEFAULT_LOG_FILE" ]]; then
    info "last 10 lines of $DEFAULT_LOG_FILE:"
    tail -10 "$DEFAULT_LOG_FILE" | sed 's/^/      /'
  else
    info "no log file yet (host has not been launched by Chrome since install)"
  fi
  echo

  # startup-error.log is written by host.js's boot trap when a required
  # module fails to load before logger initializes. Chrome would surface this
  # as the opaque "Native host has exited" — this file is the only trail.
  local startup_err="$(dirname "$DEFAULT_LOG_FILE")/startup-error.log"
  say "$(c_dim 'Boot crash log')"
  if [[ -f "$startup_err" ]]; then
    fail "startup-error.log exists — host.js has been crashing on boot"
    info "contents:"
    tail -20 "$startup_err" | sed 's/^/      /'
    warn "fix the underlying error, then: rm \"$startup_err\""
  else
    ok "no startup-error.log — host.js has not crashed during boot"
  fi
  echo

  # Gatekeeper check — common Mac failure mode when node was installed via
  # direct download (not brew). Chrome's spawn context can be blocked by
  # quarantine even though Terminal works fine.
  if [[ "$OSTYPE" == "darwin"* ]]; then
    say "$(c_dim 'Gatekeeper quarantine check')"
    local node_for_check
    if node_for_check="$(detect_node)"; then
      if xattr "$node_for_check" 2>/dev/null | grep -q "com.apple.quarantine"; then
        fail "node binary has com.apple.quarantine: $node_for_check"
        warn "fix: xattr -d com.apple.quarantine \"$node_for_check\""
      else
        ok "node binary clean"
      fi
    fi
    if [[ -f "$LAUNCHER_PATH" ]]; then
      if xattr "$LAUNCHER_PATH" 2>/dev/null | grep -q "com.apple.quarantine"; then
        fail "wrapper has com.apple.quarantine: $LAUNCHER_PATH"
        warn "fix: xattr -d com.apple.quarantine \"$LAUNCHER_PATH\""
      else
        ok "wrapper clean"
      fi
    fi
    echo
  fi

  # Wrapper smoke test — the ONLY test that actually invokes the wrapper.
  # Catches: wrong node path baked into wrapper, missing lib/ files, broken
  # require chain, syntax errors in host.js, host.js crash before logger init.
  say "$(c_dim 'Wrapper smoke test')"
  # Smoke-test the wrapper the manifest actually points at (what Chrome
  # launches), not just the current-dir launcher. When they differ, the
  # manifest is stale — the classic "moved the project dir" failure that
  # the path-exists-on-disk check alone misses.
  local manifest_wrapper=""
  if [[ -f "$MANIFEST_PATH" ]]; then
    manifest_wrapper="$( "$node_bin" -e 'try{const m=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(m.path||"")}catch{}' "$MANIFEST_PATH" 2>/dev/null || true )"
  fi
  local smoke_target="${manifest_wrapper:-$LAUNCHER_PATH}"
  if [[ -n "$manifest_wrapper" && "$manifest_wrapper" != "$LAUNCHER_PATH" ]]; then
    warn "manifest.path ($manifest_wrapper) ≠ current-dir launcher ($LAUNCHER_PATH)"
    info "smoke-testing the manifest's wrapper (what Chrome actually launches)"
  fi
  if [[ ! -x "$smoke_target" ]]; then
    fail "wrapper not installed or not executable: $smoke_target"
    warn "run: $0 <extension-id>"
  elif command -v lsof >/dev/null 2>&1 && lsof -i :8765 -sTCP:LISTEN >/dev/null 2>&1; then
    warn "skipping smoke test — port 8765 is in use (would cause EADDRINUSE)"
    info "stop the existing host first: pkill -f 'node.*host.js'"
  else
    info "wrapper content:"
    sed 's/^/      /' "$smoke_target"
    echo

    info "invoking wrapper with /dev/null stdin (1.5s budget)..."
    local log_existed_before=false
    local log_lines_before=0
    if [[ -f "$DEFAULT_LOG_FILE" ]]; then
      log_existed_before=true
      log_lines_before=$(wc -l < "$DEFAULT_LOG_FILE" 2>/dev/null | tr -d ' ' || echo 0)
    fi

    local smoke_stdout="/tmp/cc-doctor-stdout.$$"
    local smoke_stderr="/tmp/cc-doctor-stderr.$$"
    # setsid puts the wrapper in its own session so we can kill it and any
    # descendants cleanly. The wrapper's exec replaces bash with node, so
    # killing $smoke_pid is normally enough; the negative-PID kill is for
    # edge cases where the wrapper spawned additional children.
    setsid "$smoke_target" < /dev/null > "$smoke_stdout" 2> "$smoke_stderr" &
    local smoke_pid=$!
    sleep 1.5
    if kill -0 "$smoke_pid" 2>/dev/null; then
      ok "wrapper survived 1.5s — node spawned, host.js initialized"
      # Reap the wrapper (and its process group, if setsid worked).
      { kill -TERM "-$smoke_pid" 2>/dev/null; kill -TERM "$smoke_pid" 2>/dev/null; } || true
      for _ in 1 2 3 4 5; do
        kill -0 "$smoke_pid" 2>/dev/null || break
        sleep 0.2
      done
      { kill -KILL "-$smoke_pid" 2>/dev/null; kill -KILL "$smoke_pid" 2>/dev/null; } || true
      wait "$smoke_pid" 2>/dev/null || true
    else
      wait "$smoke_pid" 2>/dev/null
      local smoke_exit=$?
      fail "wrapper died before 1.5s (exit=$smoke_exit)"
      if [[ -s "$smoke_stderr" ]]; then
        info "stderr from wrapper:"
        sed 's/^/      /' "$smoke_stderr"
      fi
    fi

    if [[ -f "$DEFAULT_LOG_FILE" ]]; then
      local log_lines_now
      log_lines_now=$(wc -l < "$DEFAULT_LOG_FILE" 2>/dev/null | tr -d ' ' || echo 0)
      if [[ "$log_lines_now" -gt "$log_lines_before" ]]; then
        ok "host.log grew during smoke test ($log_lines_before → $log_lines_now lines)"
      elif $log_existed_before; then
        warn "host.log existed but did not grow — host.js may have crashed mid-init"
      else
        fail "host.log NOT created — host.js crashed before logger init"
        info "this is the classic 'Native host has exited' failure mode"
      fi
    else
      fail "host.log NOT created — host.js crashed before logger init"
      info "this is the classic 'Native host has exited' failure mode"
    fi

    # Show the new log entries from the smoke test
    if [[ -f "$DEFAULT_LOG_FILE" ]] && [[ "$log_lines_now" -gt "$log_lines_before" ]]; then
      info "new log entries from smoke test:"
      tail -n +$((log_lines_before + 1)) "$DEFAULT_LOG_FILE" | head -10 | sed 's/^/      /'
    fi

    rm -f "$smoke_stdout" "$smoke_stderr"
  fi
  echo

  say "$(c_dim 'Extension connectivity probe')"
  if command -v curl >/dev/null 2>&1; then
    local resp
    if resp="$(curl -s -m 2 http://localhost:8765/health 2>/dev/null)"; then
      ok "host is reachable on :8765"
      info "health: $resp"
    else
      warn "host not reachable on :8765 (it only listens after Chrome launches it)"
    fi
  fi

  # Overall verdict — exit non-zero if any load-bearing check failed, so
  # `scrapewright doctor` / CI can rely on the exit code (not just the printed ✓/✗).
  local doctor_status=0
  local _vb
  if ! _vb="$(detect_node)" || [[ -z "$_vb" ]]; then
    doctor_status=1
  else
    if ! check_node_version "$_vb" >/dev/null 2>&1; then doctor_status=1; fi
    if [[ ! -f "$MANIFEST_PATH" ]]; then
      doctor_status=1
    elif ! "$_vb" -e 'const fs=require("fs"),p=require("path");try{const m=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));const md=m.path?fs.realpathSync(p.dirname(m.path)):null;const cd=fs.realpathSync(p.dirname(process.argv[2]));process.exit(md&&cd&&md===cd?0:1)}catch(e){process.exit(1)}' "$MANIFEST_PATH" "$LAUNCHER_PATH" >/dev/null 2>&1; then
      doctor_status=1
    fi
    if [[ ! -x "${smoke_target:-$LAUNCHER_PATH}" ]]; then doctor_status=1; fi
  fi
  return $doctor_status
}

# --- uninstall ---------------------------------------------------------------

run_uninstall() {
  say "Removing Scrapewright native host..."
  if [[ -f "$MANIFEST_PATH" ]]; then
    rm "$MANIFEST_PATH"
    ok "removed $MANIFEST_PATH"
  else
    info "manifest was not present"
  fi
  if [[ -f "$LAUNCHER_PATH" ]]; then
    rm "$LAUNCHER_PATH"
    ok "removed $LAUNCHER_PATH"
  fi
  say "Done. Chrome will no longer attempt to launch the host."
}

# --- install -----------------------------------------------------------------

run_install() {
  local extension_id="$1"
  if [[ -z "$extension_id" || "$extension_id" == "*" ]]; then
    fail "extension-id is required."
    fail "  find it at chrome://extensions/ with Developer Mode on (32 lowercase chars)"
    fail "  example: ./install-host.sh dmbnejooocdfjmnebpglhedhfcgncgdl"
    echo
    say "Run '$0 --doctor' to check the rest of your setup."
    exit 2
  fi
  if [[ ! "$extension_id" =~ ^[a-z]{32}$ ]]; then
    warn "extension-id doesn't look like a Chrome extension id (expected 32 lowercase letters)"
    warn "proceeding anyway — but double-check at chrome://extensions/"
    echo
  fi

  say "Installing Scrapewright native host..."
  info "extension id: $extension_id"
  echo

  say "$(c_dim 'Step 1: pre-flight checks')"
  local node_bin
  if ! node_bin="$(detect_node)"; then
    fail "node not on PATH"
    warn "install Node.js $NODE_MIN_MAJOR+ first: brew install node  (or https://nodejs.org/)"
    exit 1
  fi
  ok "node found at $node_bin"

  local ver
  if ! ver="$(check_node_version "$node_bin")"; then
    ver="$("$node_bin" --version)"
    fail "node version $ver is too old — need ≥ $NODE_MIN_MAJOR"
    exit 1
  fi
  ok "node version $ver (≥ $NODE_MIN_MAJOR)"
  echo

  # Migration notice: warn if an existing manifest points outside the
  # current host dir (user moved/renamed the project). Non-fatal.
  if [[ -f "$MANIFEST_PATH" ]]; then
    local old_path=""
    old_path="$( "$node_bin" -e 'try{const m=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(m.path||"")}catch{}' "$MANIFEST_PATH" 2>/dev/null || true )"
    if [[ -n "$old_path" ]]; then
      local old_dir_resolved curr_dir_resolved
      old_dir_resolved="$( "$node_bin" -e 'const p=require("path"),fs=require("fs");try{process.stdout.write(fs.realpathSync(p.dirname(process.argv[1])))}catch{}' "$old_path" 2>/dev/null || true )"
      curr_dir_resolved="$( "$node_bin" -e 'const fs=require("fs");try{process.stdout.write(fs.realpathSync(process.argv[1]))}catch{}' "$HOST_DIR" 2>/dev/null || true )"
      if [[ -n "$old_dir_resolved" && -n "$curr_dir_resolved" && "$old_dir_resolved" != "$curr_dir_resolved" ]]; then
        say "$(c_yellow 'migrating manifest path')"
        info "old: $old_path"
        info "new: $LAUNCHER_PATH"
        info "(project directory moved or renamed — re-install was the right call)"
        echo
      fi
    fi
  fi

  say "$(c_dim 'Step 2: write wrapper script')"
  cat > "$LAUNCHER_PATH" <<EOF
#!/bin/bash
# Generated by install-host.sh — do not edit by hand.
# Re-run ./install-host.sh <extension-id> to regenerate.
exec "$node_bin" "$HOST_DIR/host.js" "\$@"
EOF
  chmod +x "$LAUNCHER_PATH"
  ok "wrote $LAUNCHER_PATH"
  echo

  say "$(c_dim 'Step 3: ensure host.js is executable')"
  chmod +x "$HOST_DIR/host.js"
  ok "host.js is executable"
  echo

  say "$(c_dim 'Step 4: install manifest')"
  mkdir -p "$MANIFEST_DIR"
  cat > "$MANIFEST_PATH" <<EOF
{
  "name": "$HOST_NAME",
  "description": "Scrapewright Native Messaging Host",
  "path": "$LAUNCHER_PATH",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://$extension_id/"]
}
EOF
  ok "wrote $MANIFEST_PATH"
  echo

  say "$(c_dim 'Step 5: prepare log directory')"
  mkdir -p "$(dirname "$DEFAULT_LOG_FILE")"
  ok "log dir ready: $(dirname "$DEFAULT_LOG_FILE")"
  echo

  say "$(c_green 'Install complete.')"
  echo
  say "What happens next:"
  info "1. Restart Chrome (or reload the extension)."
  info "2. Open the extension — it should connect within ~1 second."
  info "3. If it doesn't, run: $0 --doctor"
  echo
  say "Logs:"
  info "tail -f \"$DEFAULT_LOG_FILE\""
}

# --- help --------------------------------------------------------------------

show_help() {
  say "Scrapewright native host installer"
  echo
  say "Usage:"
  say "  $0 <extension-id>    Install or reinstall the native host."
  say "  $0 --doctor          Diagnose the current setup without changes."
  say "  $0 --uninstall       Remove the manifest and wrapper."
  say "  $0 --help            Show this message."
  echo
  say "Find your extension id at chrome://extensions/ (Developer Mode on)."
}

# --- entrypoint --------------------------------------------------------------

case "${1:-}" in
  --doctor|-d)
    run_doctor
    exit $?
    ;;
  --uninstall)
    run_uninstall
    ;;
  --help|-h)
    show_help
    ;;
  "")
    show_help >&2
    echo >&2
    fail "missing extension-id argument"
    echo >&2
    say "Run '$0 --doctor' to check your setup." >&2
    exit 2
    ;;
  *)
    run_install "$1"
    ;;
esac
