# Scrapewright — System Technical Whitepaper

> Version: 0.1.0 | Last updated: 2026-07-16 · [中文版](./technical-whitepaper.md)

## 1. System Overview

Scrapewright is an LLM-driven web data extraction platform composed of a Chrome Extension (Manifest V3) and a Node.js background service (HTTP server). Users describe a scraping need in natural language; an LLM automatically analyzes the target page structure, generates a scraping script, executes it inside a real browser, and returns structured data.

### Design Goals

| Goal | How it is achieved |
|------|--------------------|
| **No-code scraping** | Natural-language description → LLM generates script → automatic execution |
| **Real browser environment** | Injected as a Chrome extension; supports JS rendering, iframes, dynamic loading |
| **AI self-healing** | On script failure, automatically captures a DOM snapshot → LLM repairs → retry |
| **Standard API** | HTTP API for external callers, async execution queue, JSON Schema-constrained I/O |
| **Visual operation** | 5-phase wizard, element annotation, real-time execution log |

### Tech Stack

- Chrome Extension Manifest V3 (Service Worker + Offscreen API + sandboxed iframe)
- Vanilla JavaScript (no front-end framework dependency)
- Node.js >= 18 (HTTP background service)
- OpenAI-compatible API (supports OpenAI, Moonshot, Kimi, Anthropic, GLM)

## 2. System Architecture

### 2.1 Process Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                      External caller                             │
│                    HTTP POST /execute                            │
└────────────────────────────┬─────────────────────────────────────┘
                             │
┌────────────────────────────▼─────────────────────────────────────┐
│                   HTTP Host (Node.js background service)          │
│                                                                  │
│  ┌──────────────┐  ┌──────────────────────┐                      │
│  │ HTTP Server  │  │ Extension Poll       │                      │
│  │ (API router) │  │ (long-poll channel)  │                      │
│  └──────┬───────┘  └──────────┬───────────┘                      │
│         └─────────────────┬────┘                                  │
│                           │                                       │
│              sendToExtension() — unified send                    │
│              handleIncomingMessage() — unified receive           │
└───────────────────────────┼──────────────────────────────────────┘
                            │ HTTP long-polling (both directions)
┌───────────────────────────▼──────────────────────────────────────┐
│                   Chrome Extension (Manifest V3)                 │
│                                                                  │
│  ┌──────────────────────────────────────────────────────────────┐│
│  │              background.js (Service Worker)                  ││
│  │  ExecutionQueue ── ServiceRegistry ── LLMClient              ││
│  │  StepOrchestrator ── OffscreenExecutor ── AutoFix            ││
│  │  LongPollingClient                                            ││
│  └────────┬──────────────────────┬──────────────────────────────┘│
│           │                      │                               │
│  chrome.tabs.sendMessage   chrome.runtime.sendMessage            │
│           │                      │                               │
│  ┌────────▼──────────┐  ┌───────▼──────────┐                     │
│  │ content-script.js │  │  offscreen.js     │                     │
│  │ (injected into    │  │  (Offscreen Doc)  │                     │
│  │  target page)     │  │                    │                     │
│  │                    │  │                    │                     │
│  │ ┌──────────────┐ │  │ ┌──────────────┐  │                     │
│  │ │ sandbox.html │ │  │ │ sandbox.html │  │                     │
│  │ │ (eval sandbox)│ │  │ │ (eval sandbox)│  │                     │
│  │ └──────────────┘ │  │ └──────────────┘  │                     │
│  └──────────────────┘  └───────────────────┘                     │
└──────────────────────────────────────────────────────────────────┘
```

### 2.2 Single Communication Channel (HTTP long-polling)

The extension and host communicate exclusively over HTTP long-polling:

- The extension issues `GET /api/v1/extension/poll` and holds the connection until the host has a request to deliver.
- The extension replies via `POST /api/v1/extension/response`.

The host runs as an OS background service (systemd user unit / launchd LaunchAgent / Windows scheduled task). The extension only needs to know the port the host listens on (default 8765; configurable via `chrome.storage.local` and `scrapewright install --port=N`).

```
External program
    |
    | HTTP POST /api/v1/services/{name}/execute
    v
+------------------+                          +------------------+
|  host.js         |   HTTP long-polling      |  background.js   |
|  (Node.js        | <-----------------------> |  (Service Worker)|
|   background     |  /extension/poll          +--------+---------+
|   service)       |  /extension/response      |                 |
+------------------+                           |                 |
                                               v chrome.tabs.sendMessage
                                               +------------------+
                                               | content-script.js|
                                               +--------+---------+
                                                        |
                                                        | postMessage
                                                        v
                                               +------------------+
                                               | sandbox.html     |
                                               |  (eval allowed)  |
                                               +------------------+
```

**Why we dropped Native Messaging:** the MV3 service worker is killed after ~5 minutes of idleness, and `chrome.runtime.connectNative` does not reliably reconnect on worker restart. Chrome's own version updates invalidate live native connections. On macOS, Homebrew upgrades can shift `/usr/local/bin/node`, silently breaking the absolute path embedded in the manifest. Length-prefixed JSON framing drifts out of sync after long uptime, leaving the port in a zombie state. HTTP is stateless — every `fetch()` is a fresh request, naturally tolerant of transient failure, debuggable with `curl`, and works identically for local-dev and distributed-server deployments.

**Connection logic** (`background.js:initCommunication`): probe `GET /api/v1/extension/poll` → if reachable, enter long-polling mode; if not, mark disconnected and let the keepalive heartbeat (via `chrome.alarms`, roughly every 24s) retry automatically.

### 2.3 Dual-Sandbox Design

MV3's Content Security Policy (CSP) forbids `eval` / `new Function` in the Service Worker and content scripts. The system therefore uses two sandboxes:

1. **A sandboxed iframe inside `content-script.js`** — handles script execution for direct page injection (legacy path, kept for compatibility).
2. **A sandboxed iframe inside `offscreen.js`** — the primary execution path, created via the Offscreen API as an independent document.

Both sandboxes load `sandbox.html` (declared as a sandbox page in `manifest.json`) and have `eval` permission.

### 2.4 Project Layout

The repository is organized as follows:

```
extension/                # Chrome Extension (Manifest V3)
  background.js           # Service Worker — execution queue, script orchestration, retry, AI auto-fix, long-poll client
  content-script.js       # Content script — DOM op proxy, element annotation, page snapshot
  sandbox.html/js         # Sandbox page — eval/new Function runs here (MV3 CSP requirement)
  wizard.html/js/css      # 5-phase AI wizard — service create/edit flow
  options.html/js/css     # Options page — LLM settings, service management, execution history
  popup.html/js           # Popup
  lib/
    llm-client.js         # LLM client — supports OpenAI / Moonshot / Kimi / Anthropic / GLM
    offscreen-executor.js # Script executor — Offscreen API wrapper with timeout protection
    step-orchestrator.js  # Step orchestrator — conditional step-graph execution, loop detection, auto-retry
    service-registry.js   # Service registry — persisted to chrome.storage.local
    wizard-utils.js       # Wizard utilities — DSL guide, JSON sanitization, schema rendering
    import-utils.js       # Import utilities — data validation, dedup filtering
    dom-snapshot.js       # DOM snapshot — compact structure extraction (used by tests)
    debug-logger.js       # Debug logger — structured logs + auto-cleanup
    script-executor.js    # Legacy executor (kept for $openTab compatibility)
  test/                   # Extension unit tests

native-host/              # Node.js HTTP background service
  host.js                 # HTTP server — receives external API calls and forwards them to the extension via long-polling
  lib/
    service-install/      # OS service installers (systemd / launchd / scheduled task)
      locate-node.js      # Resolve absolute path to node (PATH-independent)
      linux.js            # Write ~/.config/systemd/user/scrapewright.service
      macos.js            # Write ~/Library/LaunchAgents/com.scrapewright.host.plist
      windows.js          # Register scheduled task ScrapewrightHost (PowerShell)
      index.js            # Dispatch by process.platform
    migration.js          # Detect and clean up legacy Native Messaging artifacts (manifest / registry)
  host.cmd                # Windows launcher wrapper
  test/                   # Tests
```

### 2.5 Chrome MV3 Constraints

Chrome Manifest V3 imposes several hard constraints that directly shaped the design:

| Constraint | Impact | Mitigation |
|------------|--------|------------|
| Service worker cannot run an HTTP server | Extension can't expose an API directly | Introduce a Node.js HTTP background service as the bridge (run as an OS service) |
| `eval` / `new Function` forbidden in service worker and content script | Cannot execute user scripts directly | Create a sandbox iframe (declared in manifest) and run dynamic code there |
| Each extension can have only 1 offscreen document | Script execution surface is a singleton | Serialize execution through ExecutionQueue; multi-instance deployment sidesteps the limit |
| Service worker can be killed after ~30s idle | Long-poll loops may break | `chrome.alarms` heartbeat every 24s, auto-reconnect on disconnect |
| `chrome.storage.local` capped at 10MB | Large job data may overflow | 100-job cap + 24h TTL cleanup; future migration to IndexedDB |

## 3. Core Data Flow

### 3.1 Service Execution Flow

```
External POST /execute
  → host.js: sendToExtension({type:'EXECUTE', serviceName, input})
  → background.js: handleHostMessage()
    → createJob() → enqueue into ExecutionQueue
    → returns {jobId, status:'queued'}

Background processing:
  → processJob(jobId, serviceName, input)
    → handleExecute()
      → registry.getByName(serviceName)
      → StepOrchestrator.execute(service, input, deps)
        → create tab → wait for load
        → loop over steps:
          → OffscreenExecutor.execute(stepScript, input)
            → ensure Offscreen document exists
            → send EXECUTE_SCRIPT_OFFSCREEN
            → offscreen.js forwards to sandbox iframe
            → sandbox.js: new Function(scriptCode)()
            → $ API calls emit DOM_REQUEST → content-script.js executes
            → result returns the same way via DOM_RESPONSE
            → sandbox.js sends EXECUTE_RESULT
            → offscreen.js forwards SCRIPT_RESULT back to background
        → evaluate condition → decide next step → loop
        → return {finalResult, steps}
      → on failure: tryAutoFixStep() → LLM repairs script → retry
    → updateJob({status, result/error})
```

### 3.2 `$` API Call Chain (using `$click` as the example)

```
sandbox.js: $click('button.submit')
  → sendDomRequest('click', 'button.submit')
  → parent.postMessage({type:'DOM_REQUEST', action:'click', ...})

offscreen.js receives DOM_REQUEST:
  → chrome.runtime.sendMessage({type:'DOM_REQUEST', tabId, _fromOffscreen})

background.js receives and forwards:
  → chrome.tabs.sendMessage(tabId, {type:'DOM_REQUEST', ...})

content-script.js receives DOM_REQUEST:
  → handleDomRequest({action:'click', selector:'button.submit'})
  → domClick('button.submit')
    → domQuerySelector('button.submit') — wait for element to appear
    → querySelectorDeep(sel) — search main document + same-origin iframes
    → element.click()
  → returns {result: true}

content-script.js sends DOM_RESPONSE:
  → chrome.runtime.sendMessage({type:'DOM_RESPONSE', id, result, _fromOffscreen})

offscreen.js receives DOM_RESPONSE (after dedup):
  → sandboxIframe.contentWindow.postMessage({type:'DOM_RESPONSE', id, result})

sandbox.js receives DOM_RESPONSE:
  → pendingDomRequests.get(id).resolve(result)
  → $click() Promise resolves
```

### 3.3 `$openTab` Detail-Page Scraping Flow

```
sandbox.js: await $openTab(url, `const title = await $extract('h1'); return {title}`)
  → sendDomRequest('openTab', null, [url, fnString])

content-script.js: domOpenTab(url, fnStr)
  → chrome.runtime.sendMessage({type:'OPEN_TAB_EXECUTE', url, script:fnStr, parentTabId})

background.js: handleOpenTabExecute(url, scriptStr, parentTabId)
  → chrome.tabs.create({url}) — new tab
  → waitForTabLoad() + waitForContentScript()
  → OffscreenExecutor(tabId).execute(wrappedScript, {})
    → [execute script in the new tab]
  → chrome.tabs.sendMessage(parentTabId, {type:'TAB_RESULT', result})
  → chrome.tabs.remove(tabId) — close the new tab

content-script.js receives TAB_RESULT:
  → __CrawlerBridge__.resolve(result)
  → $openTab() Promise resolves
```

## 4. Core Modules

### 4.1 StepOrchestrator

**File:** `extension/lib/step-orchestrator.js`

The orchestrator executes a directed step graph. Each step contains:

| Field | Description |
|-------|-------------|
| `id` | Unique identifier (string) |
| `name` | Step name |
| `script` | JavaScript code to execute |
| `condition` | Optional condition expression (evaluated in the target page context) |
| `onSuccess` | Step id to jump to on success (`'TERMINATE'` ends) |
| `onFailure` | Step id to jump to on failure / give-up (condition false, retries exhausted, or returned `{failed:true}`) |
| `maxIterations` | Max executions of this step (default 1; `>1` enables polling/retry: returning `{done:false}` reruns itself) |

> **No `SELF` sentinel.** Earlier versions used `onSuccess: 'SELF'` for self-loops with a counterintuitive convention (`{done:true}` exited via `onFailure`). This is removed. Polling/retry is now expressed by `maxIterations>1` + returning `{done:false}`; `onSuccess`/`onFailure` always point at another step id or `TERMINATE`.

**Loop detection:** Before execution, cycles in the step graph are detected automatically. When a step's `onSuccess` points to an earlier step, every step on the cyclic path has its `maxIterations` auto-boosted to the global cap (default 50).

**Safety guarantees:**
- Global iteration cap `maxStepIterations` (default 50) prevents infinite loops.
- Per-step `maxIterations` prevents single-step infinite execution.
- A `condition` evaluating to false skips the step (not counted as a failure).
- On script failure, a snapshot is captured for AI repair.

**Inter-step data passing:**
- `__lastResult__` — the previous step's return value.
- `__stepResults__` — a map of all steps' return values, keyed by step id.
- `__input__` — the original input parameters.

### 4.2 ExecutionQueue

**File:** `extension/background.js`

```
class ExecutionQueue {
  enqueue(jobId, fn) → Promise
  processNext()      → process the next serialized job
  getQueuePosition() → query position in the queue
}
```

All service executions are serialized through this queue. Reason: the Offscreen document uses a global `tabIdStack`; concurrent executions would misroute DOM requests.

### 4.3 OffscreenExecutor

**File:** `extension/lib/offscreen-executor.js`

Wraps the Chrome Offscreen API to execute scripts in an independent document.

```
class OffscreenExecutor {
  constructor(tabId)
  ensureOffscreenDocument()   → create the Offscreen document
  execute(scriptCode, input)  → execute the script, await the result
  wrapScript(code)            → wrap as an async IIFE
}
```

**Timeout:** Default 30s, configurable. On timeout, it sends `EXECUTE_SCRIPT_TIMEOUT` to clean up the `tabIdStack` in `offscreen.js`.

### 4.4 ServiceRegistry

**File:** `extension/lib/service-registry.js`

A key-value store over `chrome.storage.local` with CRUD operations.

**Service data model:**

```typescript
interface Service {
  id: string;           // crypto.randomUUID()
  name: string;         // URL-safe unique name
  displayName: string;  // human-readable name
  targetUrl: string;    // target page URL
  steps: Step[];        // array of steps
  inputSchema: object;  // JSON Schema
  outputSchema: object; // JSON Schema
  annotations: object[];// user-annotated elements
  config: {
    enabled: boolean;
    timeoutMs: number;  // default 30000
    maxRetries: number; // default 2
    autoCloseTab: boolean;
  };
}
```

### 4.5 LLMClient

**File:** `extension/lib/llm-client.js`

An OpenAI-compatible client supporting multiple providers:

| Provider | Default Base URL |
|----------|------------------|
| OpenAI | `https://api.openai.com/v1` |
| Moonshot | `https://api.moonshot.cn/v1` |
| Kimi | `https://api.moonshot.cn/v1` |
| Anthropic | `https://api.anthropic.com/v1` |
| GLM | `https://open.bigmodel.cn/api/paas/v4` |

**Error handling:**
- 404 → prompt to check the Base URL and model name.
- 401/403 → prompt to check the API key.
- Non-JSON response → detected and raises an explicit error.
- Network error → error message includes the URL.

### 4.6 DOM Snapshot

**File:** `extension/content-script.js:getDomSnapshot()` / `getCompressedSnapshot()`

Two snapshot modes:

| Mode | Use case | Size |
|------|----------|------|
| **Full** | Wizard research phase — gives the LLM the complete page structure | up to 80KB |
| **Compressed** | AI auto-repair — provides a compact structure | usually < 20KB |

**Key features:**
- Automatically expands same-origin iframe content (tagged with `data-iframe-src`).
- Cross-origin iframes are marked `[cross-origin iframe]`.
- Removes scripts, styles, hidden elements, navigation/sidebar noise.
- Attribute values are truncated to 200 characters.

### 4.7 service-install (OS service installer)

**File:** `native-host/lib/service-install/`

Provides three OS-specific service installers — Linux (systemd user unit), macOS (launchd LaunchAgent), and Windows (scheduled task) — invoked by the `scrapewright install` subcommand.

- `locate-node.js` — resolves the absolute path to `node` (uses `process.execPath` directly), independent of PATH and therefore immune to the different PATH settings Chrome / systemd / osascript each impose.
- `linux.js` — writes `~/.config/systemd/user/scrapewright.service`, calls `systemctl --user daemon-reload` + `systemctl --user enable --now scrapewright`, and runs `loginctl enable-linger <user>` so the user manager starts at boot (rather than waiting for first login). The unit sets `Restart=on-failure`, so the service comes back within ~3 seconds of a crash.
- `macos.js` — writes `~/Library/LaunchAgents/com.scrapewright.host.plist`, calls `launchctl bootstrap gui/<uid> <plist>`. `RunAtLoad=true` + `KeepAlive=true` ensure launch at login and automatic restart on crash.
- `windows.js` — registers scheduled task `ScrapewrightHost` via PowerShell `Register-ScheduledTask -Trigger New-ScheduledTaskTrigger -AtLogOn`, running as the current user with `-LogonType Interactive` (no admin / UAC required). Sets `RestartCount 3` + `RestartInterval` of 1 minute.
- `index.js` — dispatches to `linux` / `macos` / `windows` by `process.platform`; unsupported platforms throw with a hint to use `scrapewright run` for foreground execution.

Each service file embeds three things at install time: the absolute path to `node`, the absolute path to `host.js`, and the port (written into `ExecStart` / `ProgramArguments` / `-Argument` as `--port=N`). So `scrapewright install --port=9123` pins the resulting service to port 9123. After install, the service auto-starts at user login; the OS supervisor restarts it within seconds of a crash; on logout/reboot it comes back at next login/boot.

### 4.8 migration (migration safety net)

**File:** `native-host/lib/migration.js`

Detects and removes Native Messaging artifacts left by previous installs (manifest JSON files / Windows registry key). Called automatically by `scrapewright doctor` and `scrapewright install`, always with a one-line terminal notice — never silent.

- `findLegacyArtifacts()` — probes the following locations:
  - Linux: `~/.config/google-chrome/NativeMessagingHosts/com.scrapewright.host.json`
  - macOS: `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.scrapewright.host.json`
  - Windows: registry key `HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.scrapewright.host` (probed via `reg query`)
- `removeLegacyArtifacts()` — deletes each file / calls `reg delete /f` to clear the registry key, returning the lists of files and keys actually removed (the caller prints the user-visible notice). Failures are best-effort skipped (e.g. a file held by another process) and never abort the main flow.

### 4.9 DebugLogger

**File:** `extension/lib/debug-logger.js`

A structured logging system stored by date in `chrome.storage.local`:

- In-memory buffer: up to 500 entries.
- Persistence: stored under a per-date key, up to 2000 entries per day.
- Auto-cleanup: logs older than 3 days are deleted.
- Component tags: `background`, `content-script`, `sandbox`, `offscreen`, `step-orchestrator`, `wizard`.

## 5. Wizard System

**File:** `extension/wizard.js` + `wizard.html`

A 5-phase AI wizard flow:

| Phase | Purpose | Key functions |
|-------|---------|---------------|
| 1 | Enter target URL + three requirement fields, then AI research | `startResearch()` → `continueResearch()` |
| 2 | Name the service + review/edit the step graph | — |
| 3 | I/O Schema + test input | — |
| 4 | Execute the test (step by step) | `runTestFromStep5()` |
| 5 | View results + AutoFix + deploy | `confirmDeploy()` |

### AI Research Flow

```
User describes the need
  → startResearch()
    → open the target page → capture a DOM snapshot
    → LLM analyzes the page structure → returns {steps, inputSchema, outputSchema, sampleInput}
  → if annotation is needed:
    → continueResearch()
      → user annotates elements
      → LLM refines the script based on the annotations
```

**Two-round HTML protocol:** to avoid truncating large pages while keeping token usage efficient, the research phase runs in two rounds. Round one sends the LLM a compact DOM summary (~8000 tokens) and gets back candidate selectors. Round two fetches only the full HTML of those candidate elements so the LLM can confirm or correct them.

**Element annotation assist:** when the LLM's selector confidence is below threshold, the visual element annotation mode kicks in automatically, turning user intent into structured annotations that the LLM consumes directly.

### AutoFix

Triggered automatically when a script execution fails, or manually from Phase 5 with optional user feedback. Two function tiers: `autoFix(userFeedback)` is the orchestrator; `runFixIteration(userFeedback, config, options)` does the actual LLM call + script replacement.

```
testScript failure
  → autoFix(userFeedback = null)  // or autoFix(feedback) from Phase 5 button
    → MAX_ATTEMPTS = userFeedback ? 1 : 3   // silent retries vs one-shot with hint
    → reset wizardState.bestAttempt + dismissedInterventions
    → for attempt in 1..MAX_ATTEMPTS:
        → runFixIteration(...)                       // builds prompt, calls LLM, replaces step script
          on LLMContextOverflow → retry once with compacted snapshot
        → score the resulting testResult.finalResult against outputSchema
        → if score > bestAttempt.score: update bestAttempt (script + flow fields)
        → if !success: classifyIntervention(...) → on hit, show banner + break
    → on loop exit: if bestAttempt.score > currentScore, restoreBestAttempt(bestAttempt)
```

**Scoring (`scoreAttemptResult`)** is a pure helper that returns `{ score, breakdown, isData }`:

```
score = requiredCoverage * 100 + listItemCount * 10 + avgFieldsPerItem * 5
```

Required coverage is the fraction of `outputSchema.required` fields that are non-empty; list-item count is the length of the first array-of-objects field; average fields per item is how completely each list item fills its declared inner schema. The raw float is preserved (not rounded) so ties are rare. `isData: false` short-circuits best-attempt tracking for malformed/non-object results.

**Intervention classifier (`classifyIntervention`)** is a pure helper that returns `{ type, severity, message, uiAction }` or null. Five types, each gated by multiple signals to avoid false positives:

| Type | Trigger | uiAction |
|------|---------|----------|
| `needs_annotation` | score=0 + no annotations + extraction error | `annotate_step` |
| `needs_annotation_relax` | score=0 + annotations exist + (selector has `:nth-of-type`/`:nth-child` OR list empty at attempt ≥ 2) | `annotate_step` |
| `needs_login` | `LOGIN_REQUIRED` in error or lastError | `open_tab` |
| `rate_limited` | `429` in error or lastError | `open_settings` |
| `page_state_stale` | attempt ≥ 2 + repeated same error + snapshot older than 60s | `refresh_tab` |

Candidates are filtered by the user's dismissed set, then ranked by an internal priority (login > rate-limit > stale > relax > annotation) so the most actionable intervention wins.

**Restore on regression (`planRestoreBestAttempt`)** is a pure planning helper. Given the best-attempt record + current steps + llmHistory, it returns the step patch (script/onSuccess/onFailure/maxIterations) plus a truncated llmHistory cut at the boundary of the best attempt's `[Attempt — step "<id>" ("<name>")]` marker. The runtime wrapper `restoreBestAttempt(best)` applies the patch to `wizardState.steps`, syncs the step-editor textareas (so confirmDeploy's syncStepsFromEditor doesn't overwrite the restore), and updates the `#currentScript` preview.

#### ACK/NACK protocol

When user feedback is supplied, `runFixIteration` prepends a `buildFeedbackSection(feedback, attemptNum, totalAttempts, llmHistory)` block as Section 1 of the prompt — before the SCRIPT_DSL_GUIDE. The block instructs the LLM to emit exactly one of:

```
// ACK: <paraphrase the hint in your own words>
// NACK: <why you cannot apply it, with specifics>
```

…before writing any script. `cleanLLMResponse` strips this leading protocol line (logging it via debugLogger for observability) so the downstream code-fence / JSON extraction runs on the clean script body. If the same hint has been NACKed twice in `llmHistory`, the block appends an escalation note telling the model its page model may be wrong.

**Limit:** at most `MAX_ATTEMPTS` (3 silent, or 1 with user feedback). Triggered only for `ELEMENT_NOT_FOUND` and `SCRIPT_ERROR` error types; `LOGIN_REQUIRED` fails fast.

## 6. HTTP API Reference

**Base URL:** `http://localhost:{port}/api/v1`
**Auth:** `X-API-Key` request header

### 6.1 Request / Response Format

All responses are JSON. On success `success: true`; on failure the response includes an `error` field.

### 6.2 Asynchronous Execution Model

```
POST /services/{name}/execute  → 202 Accepted, returns jobId
GET  /jobs/{id}/wait?timeout=N → blocks until completion
GET  /jobs/{id}                → returns the current state immediately
```

### 6.3 Messaging Protocol

The host and extension communicate bidirectionally over stateless HTTP long-polling:

- **Request delivery:** `GET /api/v1/extension/poll` — the extension opens a long-poll. The host blocks on that connection until a request is pending, then returns the full request object. When the queue is empty it returns `204 No Content` on timeout, and the extension immediately issues the next poll.
- **Response delivery:** `POST /api/v1/extension/response` — the extension POSTs the execution result (with `reqId`) to the host, which resolves the corresponding waiter by `reqId`.

Request/response message format (HTTP JSON body):

```typescript
// Host → extension (poll response body)
interface HostMessage {
  type: 'EXECUTE' | 'GET_JOB_STATUS' | 'GET_JOBS' | 'GET_SERVICES' | 'CANCEL_JOB';
  reqId: number;        // request id, used to match the response
  serviceName?: string;
  input?: object;
  jobId?: string;
}

// Extension → host (response request body)
interface ExtensionResponse {
  reqId: number;
  success: boolean;
  jobId?: string;
  job?: Job;
  services?: Service[];
  error?: string;
}
```

Because each HTTP request is independent, there is no connection "establish / maintain / disconnect" state machine. A transient failure (service worker restart, network blip, Chrome version upgrade) takes down at most a single `fetch()`; the next retry recovers.

## 7. Scraping Script DSL

### 7.1 Execution Environment

Scripts run inside a sandboxed iframe and communicate with the target page via `postMessage`. They cannot touch the DOM directly.

### 7.2 Available APIs

| API | Return type | Description |
|-----|-------------|-------------|
| `$(selector)` | ElementData | Wait for an element (30s timeout), return a data object |
| `$click(selector)` | boolean | Click an element |
| `$type(selector, text)` | boolean | Type text |
| `$extract(selector, attr?)` | string | Extract text or an attribute |
| `$wait(selector, delayMs?)` | boolean | Wait for an element + optional delay |
| `$exists(selector, timeoutMs?)` | boolean | Check whether an element exists (default 5s) |
| `$check(selector, property)` | any | Read an element property |
| `$list(selector)` | ElementData[] | Get all matching elements (including iframes) |
| `$count(selector)` | number | Count matching elements |
| `$openTab(url, fnBody)` | any | Open a new tab and execute a function |

### 7.3 ElementData Structure

```typescript
interface ElementData {
  tagName: string;
  id: string;
  className: string;
  textContent: string;  // truncated to 500 chars
  value: string;
  href: string;
  src: string;
  checked: boolean;
  disabled: boolean;
}
```

### 7.4 Cross-iframe Support

All `$` APIs automatically search the main document and same-origin iframes. The `querySelectorDeep` function searches, in order:
1. The main `document`.
2. Every iframe's `contentDocument` (same-origin).

`$list` collects elements across all documents and returns them merged.

**Iframe-prefixed selectors.** When a page has multiple iframes with similar markup (e.g. one iframe per tab on government / bid / portal sites), a plain selector is ambiguous. Pin a selector to a specific iframe with the `iframe<css>::<inner>` syntax:

```
iframe#iframe1::p > u                       // element inside iframe#iframe1
iframe[src="content.html"]::p.MsoNormal      // resolve iframe by attribute
iframe#iframe1::iframe#iframe2::#deep        // nested iframes (chain the prefix)
```

The `<css>` part is a CSS selector for the `<iframe>` element evaluated in the parent document; `<inner>` is a normal CSS selector evaluated inside that iframe's document. Works in every `$` API. `generateSelector` / `getDomPath` (used by the annotation recorder) emit this prefix automatically when the user picks an element inside an iframe, so annotated selectors are deterministic at extraction time. The shared logic lives in `extension/lib/iframe-selector.js` (loaded as a content script before `content-script.js`).

## 8. Configuration & Deployment

### 8.1 Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `SCRAPEWRIGHT_PORT` | `8765` | HTTP listen port |
| `SCRAPEWRIGHT_API_KEY` | `dev-key` | API auth key |

### 8.2 Chrome Storage

Data is stored in `chrome.storage.local`:

| Key | Description |
|-----|-------------|
| `services` | Service list |
| `jobQueue` | Job queue (max 100) |
| `executionLogs` | Execution history (max 100) |
| `llmConfig` | LLM configuration |
| `serverPort` | Host port |
| `debugLogs_YYYY-MM-DD` | Per-date debug logs |

### 8.3 Service Worker Keepalive

An MV3 Service Worker sleeps after 30s of inactivity. A `chrome.alarms.create('keepalive', { periodInMinutes: 0.4 })` wakes it every 24s to check connection state and reconnect on disconnect.

## 9. Extension & Customization Guide

### 9.1 Adding a New `$` API

1. **sandbox.js** — add `window.$newApi = (...) => sendDomRequest('newAction', ...)`.
2. **content-script.js** — add a `case 'newAction':` handler and a `domNewAction()` implementation.
3. **wizard-utils.js** — update the API list in `SCRIPT_DSL_GUIDE`.
4. **wizard.js** — if the wizard should use it, update the relevant prompt.

### 9.2 Adding a New LLM Provider

1. **llm-client.js** — add a case in `getDefaultBaseUrl()`.
2. **options.js** — add an option in the provider dropdown.
3. If the provider is not OpenAI-compatible, adapt the `chat()` method.

### 9.3 Custom Step Templates

Add a new template to the `STEP_TEMPLATES` array in `wizard-utils.js`:

```javascript
{
  id: 'my-template',
  name: 'My Template',
  description: 'Template description',
  steps: [{ id, name, script, onSuccess, onFailure, maxIterations }]
}
```

### 9.4 Modifying the DOM Snapshot Strategy

`content-script.js:getDomSnapshot()` controls the full snapshot, `getCompressedSnapshot()` controls the compressed one. When modifying:
- Update `lib/dom-snapshot.js` in sync (the test copy).
- Preserve the `data-iframe-src` tagging convention (the LLM relies on it to recognize iframe content).

### 9.5 Debugging Tips

1. **Enable extension debug logging:** view structured `[component]`-prefixed logs in the Chrome DevTools Console.
2. **Inspect persisted logs:** run `chrome.storage.local.get(null, console.log)` in the Console to see all stored data.
3. **Manually test a script:** edit the script directly in wizard Phase 2.
4. **Export debug data:** the Options page can export service configs and execution history.

## 10. Known Limitations

| Limitation | Reason | Impact |
|------------|--------|--------|
| Only one job runs at a time | The Offscreen document uses a global tabIdStack | Concurrent requests queue |
| Cannot scrape cross-origin iframe content | Browser same-origin policy | Cross-origin content is invisible |
| Service Worker may sleep | MV3 constraint, 30s inactivity | Kept alive via alarm; extreme cases may lag |
| AI repair retries at most 2 times | Prevents infinite retry loops | Complex errors may need manual repair |
| No built-in login-state management | No cookie management feature | Pages requiring login need a manual login first |
| Default API key is `dev-key` | Development convenience | Production must set `SCRAPEWRIGHT_API_KEY` |

## 11. Development & Contributing

### Running tests

```bash
# Run background-service tests
cd native-host && npm test

# Run a single test file
cd native-host && node --test test/host.test.js

# Run extension tests (needs jsdom from the repo root)
cd extension && node --test test/*.test.js lib/*.test.js
```

### Running the host in the foreground (custom port, for debugging)

```bash
./bin/scrapewright run --port=19880
# or invoke node directly
cd native-host && node host.js --port=19880
```

In foreground mode the extension still uses the same HTTP long-polling protocol; make sure the port on the extension Options page under **Server Configuration** matches the `--port` argument (`./bin/scrapewright doctor` detects a port mismatch on either side and prints a hint).

### Install as an OS service (recommended for production)

```bash
./bin/scrapewright install               # install and start (default port 8765)
./bin/scrapewright install --port=9123   # pin to a custom port
./bin/scrapewright status                # service status + /health
./bin/scrapewright doctor                # full diagnostic
./bin/scrapewright restart               # restart the service after editing code
./bin/scrapewright logs -f               # tail the log
./bin/scrapewright uninstall             # stop and remove the service
```

The service starts automatically at user login; on crash the OS supervisor (systemd / launchd / scheduled task) restarts it within seconds. `scrapewright doctor` and `install` automatically detect and clean up legacy Native Messaging artifacts (manifest files / Windows registry key), printing a one-line terminal notice.

### Restarting after a code update

After editing extension files, reload the extension at `chrome://extensions/` (click the refresh icon on the extension card). After editing background-service code, run `./bin/scrapewright restart` to restart the service — no Chrome restart is needed, because HTTP is stateless: the extension's next `fetch()` hits the new process.

**Windows (PowerShell):**
```powershell
# Force-restart the service
./bin/scrapewright restart
```

**Linux / macOS:**
```bash
./bin/scrapewright restart
```
