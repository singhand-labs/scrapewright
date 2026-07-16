# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Scrapewright is an LLM-powered web scraping platform built as a Chrome Extension (Manifest V3) with a Node.js HTTP background service. The host runs as a per-OS service (systemd user unit / launchd LaunchAgent / Windows scheduled task at logon) installed by `./bin/scrapewright install`. External programs call configurable scraping services via a local HTTP API. The extension provides an AI-guided interactive wizard for service creation.

A **service** is a *step graph* (a small state machine of named steps), not a single script. Each step runs a scraping snippet in a sandbox; `onSuccess`/`onFailure` edges route control between steps to express loops, branches, and pagination. See "Step Graph model" below.

**Tech stack:** Chrome Extension MV3, Vanilla JS, Node.js >= 18. `node --test` (no Jest). Root `package.json` only provides `jsdom` (used by extension tests).

## Common Commands

```bash
# === Unified CLI (recommended entrypoint) — ./bin/scrapewright ===
./bin/scrapewright install [--port=N]   # install OS service (default port 8765)
./bin/scrapewright install --no-autostart   # install without auto-start at login
./bin/scrapewright status               # service state + /health
./bin/scrapewright doctor               # full diagnostic (exits non-zero if sick)
./bin/scrapewright start                # start the service
./bin/scrapewright stop                 # stop the service
./bin/scrapewright restart              # restart service (picks up host.js changes)
./bin/scrapewright run [--port=N]       # foreground run (debugging, log-watching)
./bin/scrapewright logs -f              # tail host log
./bin/scrapewright uninstall            # stop + remove OS service

# === Native host tests ===
cd native-host && npm test                       # node --test test/*.test.js
cd native-host && node --test test/host.test.js  # single file

# === Extension tests (need jsdom from root) ===
npm install                            # once, at repo root, for jsdom
cd extension && node --test test/*.test.js lib/*.test.js   # all
cd extension && node --test test/step-orchestrator.test.js # single file
# Note: tests live in BOTH extension/test/ and extension/lib/ (e.g. lib/service-registry.test.js).
# They require via relative paths ('../lib/...'), so run node --test from extension/.

# === Run host manually (dev mode; uses HTTP long-polling transport) ===
cd native-host && node host.js
node host.js --port=19880              # or SCRAPEWRIGHT_PORT=19880 node host.js
curl http://localhost:8765/health      # health check (no auth)

# === Inspect host log ===
tail -f ~/Library/Logs/scrapewright/host.log         # macOS
tail -f ~/.cache/scrapewright/host.log               # Linux
# Windows (PowerShell):
#   Get-Content -Wait "$env:LOCALAPPDATA\scrapewright\host.log" -Tail 20
# Override path with: SCRAPEWRIGHT_LOG_FILE=/path/to.log node host.js
# Boot crashes (before logger init) land in startup-error.log next to host.log.
```

After modifying extension files, reload the extension at `chrome://extensions/` (click the refresh icon on the extension card). Host-side changes require `./bin/scrapewright restart` to pick up. The extension's options page (`options.html`) shows a **Host Status** card with the current connection state (Connected / Disconnected), the last error, the log file path, a Reconnect button, and a Copy Diagnostics button — check there first when investigating connectivity issues.

`README.md` (English, default) and `README.zh-CN.md` (Chinese) are the canonical user-facing references — both document the full HTTP API, DSL, distributed deployment, and CDP comparison. `docs/technical-whitepaper.md` (中文) and `docs/technical-whitepaper.en.md` (English) are the design whitepaper — architecture, data flow, module reference, and extension guide. `req.md` is the original requirements spec (local only).

`examples/` holds concrete reference service definitions (`baidu4.json`, `yuanbao.json`) — full persisted service objects including `steps`, `inputSchema`, `outputSchema`, and `config`. These are the best examples of the step-graph DSL in the wild; read one before authoring or debugging a service.

## Service install internals

`./bin/scrapewright install [--port=N] [--no-autostart]` writes a per-OS service file via `native-host/lib/service-install/`:

- **Linux:** systemd user unit at `~/.config/systemd/user/scrapewright.service`. Auto-start via `systemctl --user enable --now scrapewright` + `loginctl enable-linger <user>` (so the user manager runs at boot).
- **macOS:** launchd LaunchAgent at `~/Library/LaunchAgents/com.scrapewright.host.plist`. Auto-start via `launchctl bootstrap gui/<uid> <plist>`. `KeepAlive=true` restarts on crash.
- **Windows:** scheduled task `ScrapewrightHost` with `-AtLogOn` trigger. Registered via PowerShell `Register-ScheduledTask`. No admin required.

Each service file embeds three things at install time: absolute node path (resolved by `lib/service-install/locate-node.js` via `process.execPath`), absolute host.js path, and the port as `--port=N` arg. So a user running `scrapewright install --port=9123` gets a service pinned to that port.

**Migration safety net:** `scrapewright doctor` and `scrapewright install` detect and remove any legacy Native Messaging artifacts (manifest JSON on Linux/macOS, registry key on Windows) via `native-host/lib/migration.js`. Always prints a one-line notice — never silent.

**Diagnostic order for connection failures:**
1. **Extension options page** → Host Status card. Red badge = host unreachable.
2. `./bin/scrapewright status` — service installed? `/health` reachable?
3. `./bin/scrapewright doctor` — full diagnostics (service, host, migration state, port match).
4. `./bin/scrapewright logs -f` — host's view of incoming requests.

The host writes structured logs (ISO timestamp + level + message + JSON fields) to both stderr and the log file. The log file is the lifeline when the OS service supervisor launches the host — stderr goes to the journal/launchd log. A synchronous boot trap at the top of `host.js` catches crashes *before* the logger initializes and writes them to `startup-error.log`.

The background service worker tracks `nativeState` (mode, lastError, connected/disconnected timestamps, reconnect attempts) in `chrome.storage.local`, updated at every connection transition. `mode` is `'polling'` (extension connected via long-poll) or `'disconnected'`; the legacy `'native'` value is migrated to `'polling'` on load. The options page polls `GET_NATIVE_STATUS` every 3 seconds. `RECONNECT_NATIVE` resets the polling flag and calls `initCommunication()` again.

## High-Level Architecture

### Two-Process Design

```
External Program
      |
      | HTTP POST /api/v1/services/{name}/execute   (X-API-Key header)
      v
+-------------+   HTTP long-polling                 +------------------+
|  host.js    | <=================================> | background.js    |
|  (Node.js   |   /api/v1/extension/poll            | (Service Worker) |
|   HTTP srv) |   /api/v1/extension/response        +--------+---------+
+-------------+                                             |
                                                    chrome.tabs / chrome.scripting
                                                    / offscreen messaging
                                                            v
                                                  +------------------+
                                                  | offscreen.js     |
                                                  |  (owns sandbox   |
                                                  |   iframe +       |
                                                  |   tabIdStack)    |
                                                  +--------+---------+
                                                           | postMessage
                                                           v
                                                  +------------------+
                                                  | sandbox.html     |
                                                  |  (eval allowed)  |
                                                  +------------------+
```

1. **Host** (`native-host/host.js`): HTTP server (default `:8765`, `SCRAPEWRIGHT_PORT`/`--port=`) that forwards requests to the extension via HTTP long-polling (`GET /api/v1/extension/poll` for delivery, `POST /api/v1/extension/response` for replies). Authenticates external requests with `X-API-Key` → `SCRAPEWRIGHT_API_KEY` env (default `dev-key`).
2. **Background** (`extension/background.js`): Service Worker. Owns the `ExecutionQueue` that serializes all service calls. Orchestrates scraping via `StepOrchestrator` (step graph), opens tabs, runs steps, retries on failure, AI auto-fix. Maintains the transport to the host.
3. **Offscreen** (`extension/offscreen.js` + `lib/offscreen-executor.js`): The **primary** script execution surface. `OffscreenExecutor` ensures a single offscreen document exists (`chrome.offscreen`), which itself hosts the sandbox iframe and a `tabIdStack` so concurrent-looking DOM requests route back to the originating tab.
4. **Sandbox** (`extension/sandbox.html` + `sandbox.js`): Declared sandbox page in `manifest.json`. The only place where `new Function()`/`eval()` is allowed (MV3 CSP). Scripts execute here; `$` API calls are forwarded up to the offscreen doc, then to background, then to the content script of the target tab.
5. **Content Script** (`extension/content-script.js`): Injected into all pages (`document_idle`). Performs the actual DOM operations, element annotation, and DOM snapshot capture. Its script-execution path is now **legacy** — kept only for `$openTab` (see below).

**HTTP-only transport.** `background.js: initCommunication()` probes `GET /api/v1/extension/poll` over HTTP; if the host is reachable, it uses **HTTP long-polling** (extension pulls requests via `poll`, replies via `POST /api/v1/extension/response`). There is no other transport. The host runs as an OS service (Linux systemd / macOS launchd / Windows scheduled task) installed by `./bin/scrapewright install`, so it's always available when the user is logged in.

### Step Graph model (the core mental model)

A service is defined by `steps: [...]`, each step:

```js
{ id, name, script, condition?, onSuccess, onFailure?, maxIterations? }
```

- `script` — a scraping snippet (see DSL below). Empty/`// PENDING_ANNOTATION` steps are allowed during authoring but block deploy.
- `onSuccess` — the id of the next step to run when this step **succeeds** (content ready / data extracted), or `TERMINATE` (stop). For a wait/poll step, point this at the extraction step that runs once content is ready.
- `onFailure` — the id of the next step when this step **fails or gives up** (its `condition` is false, its retry budget is exhausted, or it returned `{ failed:true }`/`{ error:'...' }`), or `TERMINATE`. Used for branches, error paths, and poll-exhaustion.
- `condition` — optional JS expression evaluated in the target tab (via `chrome.scripting.executeScript`); if false, the step is skipped and `onFailure` is followed.
- `maxIterations` — how many times a step may run. `1` (default) = a normal step that runs once. **`>1` opts the step into retry/poll semantics.** `StepOrchestrator` **auto-boosts** it to the global cap (`config.maxStepIterations`, default 50) for any step that is the target of a back-edge, so legitimate loops aren't prematurely killed.

> **No `SELF` sentinel.** Earlier versions used `onSuccess: 'SELF'` for self-loops with a counterintuitive convention (`{done:true}` exited via `onFailure`). This is **removed**. Polling/retry is now expressed by `maxIterations>1` + returning `{done:false}`. `validateChain` rejects any lingering `onSuccess:'SELF'` loudly. Legacy services must be reconfigured.

`StepOrchestrator` (`extension/lib/step-orchestrator.js`) executes the graph: create tab → walk steps following edges → collect `{ stepId, result, snapshot }[]` → return `{ finalResult, steps }`. Result signals (only inspected when `maxIterations>1`; a normal step's result is pure data and always follows `onSuccess`):
- **Not-ready** → retry the same step: `{ done:false }`, `{ ready:false }`, `{ generating:true }`, `{ loading:true }`, etc. (up to `maxIterations`, then `onFailure`).
- **Ready/data/`{done:true}`** → follow `onSuccess`.
- **Failure** → follow `onFailure`: `{ failed:true }`, `{ error:'msg' }`.

A misconfigured poll step (e.g. `onSuccess:'<next>'` but `maxIterations<=1`) will run once and advance without retrying — a visible, debuggable failure rather than a silent mis-execute. Data flows between steps via the script globals `__stepResults__` (map of prior results by step id) and `__lastResult__` (previous step's result), injected by the orchestrator into each step's input — `__lastResult__` carries state across a step's own retries, so list-iteration can be a single self-polling step.

The step chain topology is validated everywhere services are persisted (`ServiceRegistry.save` calls `wizard-utils.validateChain`): every `onSuccess`/`onFailure` target must exist, no orphans, no duplicate ids, and no `SELF`. Adding/removing/reordering steps must **relink** the chain (`wizard-utils.relinkChainToArray` + `appendStepWithChainLink`) — a naive array edit silently breaks execution, which is what the recent `relinkChainToArray` fix addressed.

### Script Execution Flow (offscreen path)

1. `background.js` creates a tab with the target URL, waits for `status === 'complete'`.
2. `StepOrchestrator` calls `deps.executeScript(tabId, stepScript, enrichedInput, timeoutMs)`.
3. `OffscreenExecutor` ensures the offscreen document, wraps the script, and sends `EXECUTE_SCRIPT_OFFSCREEN` (with `tabId` pushed onto offscreen's `tabIdStack`).
4. `offscreen.js` forwards `EXECUTE` to its sandbox iframe via `postMessage`.
5. `sandbox.js` runs `new Function('__input__','__stepResults__','__lastResult__', 'return <script>')(input, stepResults, lastResult)`. `$` API calls become `DOM_REQUEST` messages back to offscreen.
6. Offscreen relays `DOM_REQUEST` to background → `chrome.tabs.sendMessage` to the target tab's content script → content script performs the DOM op → `DOM_RESPONSE` flows back (offscreen dedupes by request id; content-script replies reach it directly *and* via a background rebroadcast).
7. On completion, sandbox posts `EXECUTE_RESULT`; offscreen pops the `tabId` and sends `SCRIPT_RESULT` (`_fromOffscreen`) to background. Timeouts send `EXECUTE_SCRIPT_TIMEOUT` so the stack is cleaned up.

**Legacy path** (`ScriptExecutor` + content-script's own sandbox iframe): still used by `$openTab`, which executes a function in a *newly opened* tab via the content script injected there. Don't extend it for new features — route through `OffscreenExecutor`.

### Script DSL ($ API)

User scripts (LLM-generated) run as `return <expr>` in the sandbox with these async globals:

- `$(sel)` — querySelector (returns element data)
- `$click(sel)`, `$type(sel, text)`, `$extract(sel, attr?)`, `$wait(sel, ms?)`, `$check(sel, prop)`
- `$exists(sel, timeoutMs?)`, `$count(sel)`, `$list(sel)` — presence/count/collection reads
- `$openTab(url, fn)` — open a new tab, run `fn` in it (legacy content-script path), return result; on failure the sub-tab's DOM is captured as `error.subTabSnapshot` before the tab is destroyed

Plus the injected context globals `__input__`, `__stepResults__`, `__lastResult__` (see Step Graph model).

### HTTP API surface

All under `/api/v1`, all require `X-API-Key` header **except** `/health` and the two internal extension-bridge endpoints:

| Method | Path | Purpose |
|---|---|---|
| POST | `/services/{name}/execute` | Submit a job → returns `{ jobId }` |
| GET | `/jobs/{id}/wait?timeout=120` | Block until done (or timeout) |
| GET | `/jobs/{id}` | Job status |
| POST | `/jobs/{id}/cancel` | Cancel |
| GET | `/jobs` | List jobs |
| GET | `/services` | List configured services |
| POST | `/services/{name}/steps` | Add a step (agent-native parity) |
| PUT | `/services/{name}/steps/{stepId}` | Update a step |
| DELETE | `/services/{name}/steps/{stepId}` | Delete a step (relinks the chain) |
| GET | `/health` | Liveness (no auth) — for LB/k8s probes |
| GET/POST | `/extension/poll`, `/extension/response` | Internal host↔extension bridge (no auth) |

Routes are matched by regex in `host.js` (more-specific routes first). The external API is always async: `execute` returns a `jobId`, clients block on `wait`.

### Error Handling & Auto-Fix

`background.js` classifies errors:
- `ELEMENT_NOT_FOUND` / `SCRIPT_ERROR` → AI auto-fix (send error + DOM snapshot + step script to LLM, regenerate, retry — max 2 attempts)
- `LOGIN_REQUIRED` → fail fast with a helpful message
- Other errors → retry up to `config.maxRetries`

Snapshots come from `lib/dom-snapshot.js`, cleaned/sanitized for the LLM by `lib/html-cleaner.js`. When a failure originates inside `$openTab`, the orchestrator prefers `error.subTabSnapshot` (the actual detail page) over re-capturing the main tab (usually the wrong page). Execution logs are stored in `chrome.storage.local` under `executionLogs` (max 100).

### LLM Integration

`extension/lib/llm-client.js` uses OpenAI-compatible `/chat/completions`. Supported providers: OpenAI, Moonshot, Kimi (Moonshot Platform), Anthropic, GLM (Zhipu AI). Custom base URLs supported. Specific messages for 404 (check URL/model), 401/403 (check API key); request/response details logged to console. The wizard (`wizard.js`, ~80KB) drives the interactive 7-step service creation flow and is paired with `wizard-utils.js` for chain validation/manipulation.

## Important Constraints

**MV3 CSP Compliance:** No `eval`/`new Function` in content scripts or service workers. All dynamic script execution must go through the sandbox page (now reached via the offscreen document). Never add inline event handlers (`onclick`) in HTML — use `addEventListener` in JS.

**Service install:** Run `./bin/scrapewright install` (Linux/macOS) or `.\bin\scrapewright.cmd install` (Windows). The CLI writes a per-OS service file (systemd unit / launchd plist / scheduled task) at install time, embedding the absolute node path, host.js path, and port. Custom port: `scrapewright install --port=N`. Run `scrapewright doctor` whenever connection fails — it surfaces service-not-installed, host-unreachable, port-mismatch, and legacy-artifact states.

**Cross-Platform:** Linux uses systemd user unit + `loginctl enable-linger`. macOS uses launchd LaunchAgent. Windows uses scheduled task at logon (no admin required). All three are per-user scope.

**Concurrency:** Only one service execution runs at a time. The `ExecutionQueue` in `background.js` serializes all calls. This is required because the offscreen document hosts a single shared sandbox iframe and `tabIdStack` — concurrent executions would route DOM requests to the wrong tab. For higher throughput, scale horizontally: run multiple host instances on different ports behind a load balancer (`deploy/scrapewright-manager.sh`, `deploy/Dockerfile`, `deploy/k8s.yaml`) — see README "Distributed deployment".

**Git Push:** The repo uses `GIT_AUTHOR_NAME`/`GIT_AUTHOR_EMAIL` env vars for commits (git identity is not configured in this environment). `push.sh` pushes to the remote; do not embed credentials in new scripts.

**Step-chain integrity:** Any code that mutates a service's `steps` array (wizard deploy, options reorder, import, auto-fix, HTTP step CRUD) must go through the relink helpers in `wizard-utils.js` and will be re-validated by `ServiceRegistry.save`/`validateChain`. Editing the array directly produces a service that saves but silently mis-executes.
