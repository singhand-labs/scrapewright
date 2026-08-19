# Scrapewright — System Technical Whitepaper

> Version: 0.1.0 | Last updated: 2026-08-18 · [中文版](./technical-whitepaper.md)

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

**Why we dropped Native Messaging:** the MV3 service worker is killed after ~5 minutes of idleness, and `chrome.runtime.connectNative` does not reliably reconnect on worker restart. Chrome's own version updates invalidate live native connections. On macOS, Homebrew upgrades can shift `/usr/local/bin/node`, silently breaking the absolute path embedded in the manifest. Length-prefixed JSON framing drifts out of sync after long uptime, leaving the port in a zombie state — alive-looking but unable to carry data. HTTP is stateless — every `fetch()` is a fresh request, naturally tolerant of transient failure, debuggable with `curl`, and works identically for local-dev and distributed-server deployments.

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
    dom-cleaner.js        # Tiered HTML cleaning — cleanPageHtml / cleanHtmlForLLM / extractAnnotationContext
    tab-activation.js     # Sticky tab activation — guarantees the scrape tab produces compositor frames
    scroll-ops.js         # Scroll operations — $scrollBy / $scrollToBottom + trusted-wheel fallback
    renderer-activation.js # Enhanced Scraping Mode — chrome.debugger trusted-input fallback
    visibility-keepalive.js # Page visibility keep-alive — MAIN-world visibilityState override
    selector-generator.js # Selector generation — short execution selector decoupled from full domPath
    annotation-cluster.js # Annotation clustering — cluster multi-sample annotations by container
    record-shape-distribution.js # Record-shape distribution — empirical-signal-first field candidates
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
    maxRetries: number; // default 1
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

**Configuration** (Options page, persisted in `chrome.storage.local` under `llmConfig`):

| Setting | Description |
|---------|-------------|
| `provider` / `baseUrl` / `model` / `apiKey` | Provider choice; a custom baseUrl supports any OpenAI-compatible gateway |
| `maxOutputTokens` | Per-request `max_tokens` cap (1024-131072, blank = 8192). Resolution chain: `options.maxTokens ?? maxOutputTokens ?? 8192` (an explicit per-call-site value wins; the config is the authoritative default) |
| `timeoutMs` | Per-request timeout; default `DEFAULT_TIMEOUT_MS=120000` |

**Retry policy** (`chatWithRetry`): the retryable status set is `RETRYABLE_STATUS = {408, 425, 429, 500, 502, 503, 504}`; network failures and timeouts (AbortError) are also retryable; default `DEFAULT_MAX_RETRIES=3` retries with exponential backoff 1s→2s→4s (capped at 8s) + 0-500ms random jitter.

**Non-retryable classes** (thrown immediately, without burning retry budget):

- `LLMContextOverflow` — `finish_reason` of the `context_length_exceeded` family: the prompt itself exceeds the model's context window, so a retry is guaranteed to fail the same way; the error message directs compression (drop history, truncate HTML).
- **Empty content + `finish_reason=length`** (RC55) — reasoning-style models burn the entire completion budget on invisible reasoning before any output (`completion_tokens` exactly equals the cap, 0 characters of content), and the burn tracks whatever cap the user sets — a deterministic failure. The error message carries the effective budget and suggests raising `maxOutputTokens` in Settings or switching to a model with lower reasoning overhead.
- Transient empty content (no overflow/length signal) **remains retryable**.

**Other error handling:**
- 404 → prompt to check the Base URL and model name.
- 401/403 → prompt to check the API key.
- Non-JSON response → detected and raises an explicit error (retryable).
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

Research spans multiple LLM rounds:

1. **Page exploration** — send a tiered-cleaned, compressed DOM structural summary to the LLM and get back candidate selectors plus a page model (`buildResearchPrompt`).
2. **Candidate-selector discovery** — combine user annotations with the DOM's own structural signals (field-candidate discovery in `lib/field-candidate-discovery.js`) to enumerate candidate containers.
3. **Selector confirmation on real element HTML** — embed only the candidate elements' full HTML into the prompt (`formatElementsForPrompt`, subject to the 30K/200K budgets of §10); the LLM confirms or corrects.
4. **Step-script generation** — generate the step graph from the SCRIPT_DSL_GUIDE + the confirmed selectors.

#### Diagnostics relay (`_diagnostics`)

DOM-operation primitives (`$extractList` / `$extractWithHover` / hover, etc.) inject `_diagnostics` at the source (candidate pool, rejection reasons, picked/considered, etc.), which flows through `DOM_RESPONSE` → orchestrator → `summarizeAllStepDiagnostics` into the autoFix prompt — so when repairing, the LLM can see *why a selector didn't hit* instead of only the empty result. Note that every hop on the relay chain (offscreen / background) must pass the field through; there is a historical regression where a relay hop silently dropped `_diagnostics`.

#### Annotation clustering and record-shape distribution

- **Annotation clustering** (`lib/annotation-cluster.js:clusterAnnotationsByContainer`): when multiple annotations fall under the same container selector, they are clustered into a multi-sample structure, and `buildAnnotationsText` hands the LLM "the shape of each record" rather than isolated individual elements. Clustering relies on `annotation.domPath` (the full chain, see §11), not the short-circuiting `selector`.
- **Record-shape distribution auto-first** (`lib/record-shape-distribution.js`): compute each record's field-fill signature from **real extraction results** (recursive dot-paths; empty string / null / empty array count as unfilled). When 2+ distinct signatures are observed, feed the empirical distribution back to the LLM so it writes real shape-switching logic — rather than relying on the user having annotated every variant, or guessing from URL patterns.

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

**Limit:** the wizard test loop performs at most 3 automatic repair rounds (silent path `MAX_ATTEMPTS=3`, i.e. 3 full LLM repair + test iterations; 1 round with user feedback). Runtime auto-repair is separately bounded by `config.maxRetries` (default 1, see §14). Triggered only for `ELEMENT_NOT_FOUND` and `SCRIPT_ERROR` error types; `LOGIN_REQUIRED` fails fast.

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

### 6.3 Step CRUD (agent-native parity)

| Method | Path | Description |
|--------|------|-------------|
| POST | `/services/{name}/steps` | Add a step |
| PUT | `/services/{name}/steps/{stepId}` | Update a step |
| DELETE | `/services/{name}/steps/{stepId}` | Delete a step and **relink** the step chain |

External programs (or an LLM agent) can add, update, and delete steps on a service directly. Deletion is not a naive array splice — `removeStepWithRelink` re-attaches the `onSuccess`/`onFailure` edges that pointed at the deleted step to that step's own follow-up targets, and every mutation is re-validated by `ServiceRegistry.save` → `validateChain` (targets exist, no orphans, no duplicate ids, no `SELF`); a broken chain is rejected at save time rather than silently mis-executing.

### 6.4 Messaging Protocol

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

### 6.5 Page Records in Results (`pages[]` and `sourcePageId`)

The `pages[]` array in a job's result records every web page seen during the scrape. Fields per entry:

| Field | Description |
|-------|-------------|
| `id` | `page_NNNN_HHHHHHHH` format. `NNNN` is the capture sequence; `HHHHHHHH` is the first 8 hex chars of `SHA-256(url + normalizedHtml)`. Two captures of the same URL with identical normalized content produce the same ID and are deduplicated; different URL or content produces a new entry |
| `url` / `title` | Page location and `<title>` at capture time |
| `capturedAt` | Unix millisecond timestamp |
| `sourceStepId` | Which step captured this page |
| `captureReason` | `step_iteration` (after a step runs) or `subtab_pre_destroy` (before an `$openTab` sub-tab is closed) |
| `hash` | Full 64-char SHA-256 hex |
| `html` | Cleaned page HTML, capped at 80,000 chars per page (over-cap: truncated with a `[TRUNCATED N chars]` prefix, `truncated: true`) |

**Size cap:** the list is capped at 50 unique pages by default; if a scrape produces more, the first 5 and last 45 entries are kept and `pagesTruncated` reports how many were dropped. Override via `config.maxPagesCaptured`; disable via `config.capturePages: false`.

**Byte budget:** the total HTML payload per job is capped at 2MB by default (bounding `chrome.storage.local` growth). When the cap is hit, middle entries are dropped (first + last are always preserved). Override via `config.maxPagesBytes` (`0` disables the byte budget; the count cap alone applies). The extension declares `unlimitedStorage`, so the browser's 10MB quota is not a hard ceiling, but the byte budget prevents runaway disk usage on long-running services.

**`sourcePageId`:** every record in an array-of-objects result gets an auto-attached `sourcePageId` linking back to its source page; flat-object results get a top-level one. Non-destructive — if the script sets `sourcePageId` itself, the orchestrator preserves the script's value.

## 7. Scraping Script DSL

### 7.1 Execution Environment

Scripts run inside a sandboxed iframe and communicate with the target page via `postMessage`. They cannot touch the DOM directly.

### 7.2 Available APIs (19 primitives)

Authoritative semantics: `SCRIPT_DSL_GUIDE` in `extension/lib/wizard-utils.js` (the definition used in LLM prompts).

| API | Return type | Description |
|-----|-------------|-------------|
| `$(selector)` | ElementData | Wait for an element (30s timeout), return a data object; throws if not found |
| `$exists(selector, timeoutMs?)` | boolean | Check whether a **visible** element exists (skips display:none / zero-size), default 5s; polling loops use this instead of `$()` |
| `$click(selector)` | boolean | Click an element |
| `$type(selector, text)` | boolean | Set a value and dispatch input/change; supports INPUT/TEXTAREA/contenteditable; a container selector searches downward for the editable child |
| `$extract(selector, attr?, timeoutMs?)` | string | Extract text or an attribute (`attr` may be a DOM property such as `outerHTML`/`innerHTML`); default 5s fail-fast, does not burn the 30s budget |
| `$wait(selector, delayMs?)` | boolean | Wait for an element (30s, MutationObserver) + optional delay |
| `$check(selector, property)` | any | Read an element property (e.g. `checked`) |
| `$openTab(url, fnBody)` | any | Open a new tab and execute a function (detail-page scraping, legacy path) |
| `$count(selector)` | number | Count matching elements (main document + same-origin iframes); forbidden to pair with `:nth-child()` iteration |
| `$list(selector)` | ElementData[] | Get all matching elements (including iframes), for iteration |
| `$extractList(containerSel, fieldMap, opts?)` | object[] | Extract a record list in **one call**: each sub-selector of fieldMap is evaluated inside each container, first match wins; avoids per-field `$list` misalignment; `opts.allowEmpty` suppresses the `empty list` throw |
| `$extractListMulti(containerSel, fieldMap, opts?)` | object[][] | Each field returns an **array of all matches within the container** (`Array<string\|null>`, not element objects). Use only when CSS cannot disambiguate; field values are arrays — index `[0]` before `.trim()` |
| `$clickInList(containerSel, subSel, opts?)` | `{clicked, errors}` | Click a sub-element inside each container; default `delayMs=500` to let animations settle (the "expand everything first, then extract" pattern) |
| `$waitForStable(selector, opts?)` | boolean | Sample textContent every `interval` (default 1500ms); true after `stableChecks` (default 2) consecutive non-empty, unchanged samples; default 20000ms timeout. Use for streaming-content completion detection |
| `$scrollBy(deltaY, selector?)` | `{scrolled, prevY, newY}` | Scroll the window or an element |
| `$scrollToBottom(selector?)` | `{scrolled, prevY, newY}` | Scroll to the bottom; `scrolled:false` means the feed is exhausted. Triggers the trusted-wheel fallback when stuck (see §9) |
| `$scrollIntoView(selector)` | `{found:true}` | Scroll an element to the viewport top (reveal a "load more" button) |
| `$hover(anchorSelector, popoverSelector?, opts?)` | `{hovered, htmlSnippet, popoverSelector, reason?}` | Dispatch a trusted mouseMoved at the anchor center and wait for the popover (default 3000ms); `opts.index` uses the Nth match (instead of the `:nth-of-type` trap). See §8 |
| `$extractWithHover(containerSel, fieldMap, opts)` | Record[] | Container-scoped extract + hover atomic primitive, see below |

**The atomicity design of `$extractWithHover`.** This primitive performs field extraction and anchor hover within the **same container element**: for each container, it extracts the fieldMap fields (scalars, same semantics as `$extractList`), then hovers each anchor matching `opts.hover.anchorSel` inside the container and appends the popover `htmlSnippet` to that record's `hovercards[]` array — each entry carries `anchorHref` (the raw href, empty string when absent) and `anchorText` (truncated to 120 characters), letting step scripts classify popover entities by "look at anchorHref first". The reason this is a primitive rather than letting the LLM hand-write a `$hover({index:i})` loop: a hand-written loop pairs a **global** anchor index with **per-container** records, so whenever containers have differing anchor counts the results are guaranteed to misalign (record A gets record B's hovercard) — container scoping makes this class of misalignment structurally impossible. `opts.containerIndex` / `containerRange` / `maxContainers` can split large batches of containers across multiple orchestrator iterations to spread the step timeout.

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

## 8. Hovercard Enrichment (hover-based rich extraction)

**Files:** `domHover()` / `hoverDismiss()` in `extension/content-script.js`, plus `extension/lib/renderer-activation.js` (CDP dispatch)

On many sites the list DOM carries only summary fields; the complete information (account bios, entity preview cards) lives in hover popovers. This chapter is a principled description of that subsystem; every constant comes from incident-driven tuning. Throughout this section, *popover* refers to the transient DOM element that appears on hover, while *hovercard* refers to the enriched record data extracted from it.

### 8.1 Trusted-event dispatch

`domHover` first scrolls the anchor into view via `scrollIntoView({block:'center'})` (otherwise the bounding rect of a collapsed element below the fold is out-of-bounds coordinates and CDP would hit the wrong pixel), takes the center of its bounding box, then goes through `withTabActivation('hover', ...)` → `chrome.runtime.sendMessage({type:'TRUSTED_HOVER_REQUEST', x, y})` → background → `RendererActivation`, which transiently attaches `chrome.debugger` and issues CDP `Input.dispatchMouseEvent({type:'mouseMoved'})`. CDP input enters through Chrome's real input pipeline, so the resulting event has `event.isTrusted=true` — many sites' hover handlers filter synthetic events outright (`dispatchEvent` produces `isTrusted=false`), which makes this the only reliable way to trigger hover programmatically. Every CDP step is wrapped in a `CDP_STEP_TIMEOUT_MS=2000` timeout (so a detached state can't hang the orchestrator).

### 8.2 Dual-channel popover discovery

- **Path (a) explicit popoverSelector:** when the caller (the LLM) names the popover container, poll it directly (`querySelectorDeep` + `isElementVisible`).
- **Path (b) auto-discovery:** a `MutationObserver({childList:true, subtree:true})` on `document.body` — React Portal / Vue Teleport / Popper / Floating UI all render popovers as new body-level elements. **The observer must be set up BEFORE the hover dispatch**: page handlers may mount the popover synchronously during the CDP roundtrip, and a late-starting observer never sees changes that already happened (the RC36 lesson).
- **Invisible-wrapper descend** (RC49): portal frameworks commonly "mount an invisible wrapper DIV first, render content later". When pushCandidate receives an invisible added node, walk the descendants (capped at 50) and push visible descendants into the pool with `source='added'` — the filter used to check visibility at the wrong DOM level, leaving 82/116 iterations empty-handed.
- **elementsFromPoint sampling:** MutationObserver alone misses **pre-allocated** popovers (the framework puts an empty container in place at page load and hover only toggles CSS visibility — no mutation records at all). Sample `document.elementsFromPoint` at the cursor and cross offsets, pushing hits into the pool with `source='efp'`.

### 8.3 Multi-signal scoring cascade

Candidates first pass a filter (visibility + size + within viewport + ≤600px from cursor + area ≤50% of viewport + baseline diff), then are sorted by the cascade and the top pick wins. **Exact order** (finalized in RC46):

```
source ('added' beats 'efp') > posAbsolute > z-index > dist > area
```

- **source ranks first:** a node that just appeared in the MutationObserver buffer is the strongest signal of popover mount and must unconditionally beat pre-existing page chrome sampled via efp. A real popover (`source:'added'`, `posAbsolute:false`) once lost to pre-existing positioned chrome (`source:'efp'`, `posAbsolute:true`) — RC46 ended this class of mis-pick by moving source ahead of posAbsolute.
- **The 600px distance cap** (RC41 set 400, RC42 relaxed to 600): a universal UX property — hovercards always sit near the anchor; but portal frameworks often mount the popover 400-500px below the cursor (the popover grows downward from the anchor, with the cursor at its top edge). A real popover at 496px was once rejected by the 400 cap.
- **Area rejection >50% of viewport:** a full-screen backdrop/modal is not a hovercard.
- Where to tune for secondary development: these constants are all local `var`s inside `domHover` (`NO_SIGNAL_EARLY_EXIT_MS`, `600`, `viewportAreaThreshold`, etc.); after changing them, sync the regression tests under `extension/test/`.

### 8.4 Quality gates

- **min-dwell 500ms** (`MIN_AUTO_DISCOVER_DWELL_MS`): in the first few hundred milliseconds after hover the scoring pool is full of "pre-existing" noise (page chrome not yet changed by the hover); ticks earlier than 500ms do not make path-(b) decisions.
- **Content triple gate** (RC43, path a): `popoverSelector MATCH != popover RENDERED`. Acceptance requires all of: has content (trimmed text ≥20 chars, `MIN_HOVERCONTENT_TEXT_LEN`) + **differs** from the T0 baseline outerHTML (rejects pre-allocated empty shells) + stable (the same element's outerHTML equal across two consecutive 100ms `STABILITY_SAMPLE_INTERVAL_MS` samples — catches streaming-render intermediate states).
- **efp baseline rejection** (path b): at T0 before the hover, build a `Set` of all outerHTML at the cursor + cross offsets via `elementsFromPoint`; a candidate with `source!=='added'` whose outerHTML hits that set is rejected — pre-existing page chrome must not win the cascade on position:absolute alone.
- **No-signal early exit** `NO_SIGNAL_EARLY_EXIT_MS=1500` (RC47): real hovercards mount within 600-1600ms; past 1500ms with neither MutationObserver additions nor a visible popoverSel match, this anchor almost certainly has no hovercard — exit early instead of burning the full 3000ms default timeout. When the LLM occasionally writes an over-broad anchorSel (matching permalinks, timestamps too), this cuts the step's runtime by roughly half. The result is returned via the `reason` field so autoFix can distinguish "this anchor has no hovercard" from "waited out the timeout".

### 8.5 The symmetry principle (hover vs. dismiss)

Dismiss (moving the trusted cursor to (1,1) to trigger mouseout and close the popover) goes through the **same CDP command chain** as hover, so it must share all infrastructure. Two separate incidents each caused near-100% dismiss failure:

- **RC48 (timeout symmetry):** the dismiss path once compressed the CDP mouseMoved + detach timeout to 500ms while hover used 2000ms — same command, same tab, and 98% of dismisses timed out. Fix: delete the override; both sides use the default 2000ms (`CDP_STEP_TIMEOUT_MS`; do not compress back below 1500).
- **RC50 (activation symmetry):** after RC48, dismiss still failed 100% — the root cause was that background tabs produce no compositor frames, so CDP input hangs; the hover path had been wrapped in `withTabActivation` since RC20 (see §9.1), the dismiss path was missed. Fix: dismiss is likewise wrapped in `withTabActivation('hoverDismiss', ...)`.

Failed dismisses cascade into worse outcomes: the previous hovercard stays mounted → the site suppresses subsequent hovers. Principle: **same CDP command → same infrastructure**; any "optimization" that touches only one side is an incident waiting to happen.

### 8.6 Diagnostics and classification

The scoring process reports via `notifyBackgroundDiagnostic('hover_auto_discover', {...})`: pool/passing/rejected (with per-node rejection reasons)/picked/considered (top 3)/baselineEfpCount — hovercard-family bugs can be located from SW logs alone. Every hovercard entry from `$extractWithHover` carries `anchorHref` (empty string when absent) and `anchorText`; the DSL rules teach the LLM to **classify by anchorHref first**, then parse the `htmlSnippet` with `DOMParser` for bucketing.

## 9. Renderer-Throttling Countermeasure Stack (five layers)

Scrape tabs are opened as background tabs by default (`chrome.tabs.create({active:false})`) so the user's keyboard focus is never stolen. For `IntersectionObserver`-driven lazy-load sites (social feeds, infinite scroll, virtualized lists), background tabs hit Chrome's multi-layer throttle/filter mechanisms. Five stacked layers each target a distinct mechanism — they stack rather than replace:

| Layer | Module / CLI | Mechanism | Throttle type countered |
|-------|--------------|-----------|-------------------------|
| 1. visibility-keepalive | `lib/visibility-keepalive.js` (default on) | Injects a MAIN-world override of `document.visibilityState='visible'` + rAF keep-alive loop | Only page-JS that checks visibility **itself** to decide whether to keep loading. Does **not** produce compositor frames |
| 2. Enhanced Scraping Mode | `lib/renderer-activation.js` (options-page toggle, `enhancedModeEnabled` flag) | Now only gates availability of the layer-4 trusted-wheel fallback. RC20 removed `Page.setWebLifecycleState` (RC18 Plan A) — brief activation (layer 5) already makes lifecycle naturally ACTIVE during the input window, so the call became pure overhead; when the flag is on only `Input.*` CDP commands are issued, never `Runtime.*`/`Network.*`/`DOM.*` (detection risk minimized) | Input-event trust gates — sites that degrade the render lifecycle to frozen/discard and restore interactivity only for trusted input (a historical solution fought this layer head-on; it is now naturally covered by layer-5 activation) |
| 3. Chrome launch flags | `scrapewright throttle on\|off\|status` (`native-host/lib/throttle-config/`) | Rewrites the Chrome launcher per-OS (Linux `.desktop`, macOS wrapper AppleScript app, Windows `.lnk`) to add `--disable-background-timer-throttling`, `--disable-backgrounding-occluded-windows`, `--disable-renderer-backgrounding`, `--disable-features=CalculateNativeWinOcclusion` | Renderer-side background throttling and native window occlusion calculation. Requires Chrome restart, applies globally; necessary but **not sufficient** (does not fix `isTrusted` filtering or frame production) |
| 4. Trusted-wheel fallback (RC19) | `renderer-activation.js:dispatchTrustedWheelScroll` + `scroll-ops.js` | When programmatic `scrollBy` stalls (scrollHeight stops growing), transiently attach `chrome.debugger` and send `Input.dispatchMouseEvent` mouseMoved + `mouseWheel`. CDP input produces a wheel event with `isTrusted=true` — the **only** programmatic way to produce a trusted wheel event. `DEFAULT_MAX_TRUSTED_WHEEL_ATTEMPTS=3` per invocation; relay chain: content-script → `TRUSTED_WHEEL_SCROLL_REQUEST` → background → `RendererActivation` | Sites whose lazy-load loader filters non-trusted wheel events. The LLM keeps writing `$scrollToBottom` as usual and the infrastructure falls back transparently — no site-specific logic |
| 5. Sticky activation (RC56) | `lib/tab-activation.js` (default on) | See below | The **only** layer aimed at frame production: Chrome's hard architectural rule — compositor frames are produced only for the active tab in the focused window; both IO callbacks and CDP `Input.dispatchMouseEvent` require activation |

### 9.1 Sticky activation (RC56)

RC20's "activate → op → restore" caused activate/restore churn between back-to-back ops. RC56 switches to **activate and keep** (no automatic switch-back):

- `requestActivation(tabId)` uses `chrome.tabs.update({active:true})` to switch to the scrape tab and **keeps** it active; when the next op arrives, no re-activation is needed if the user hasn't switched away — if they have, it simply re-activates.
- **A suppression set** distinguishes our own activations from user clicks: `chrome.tabs.onActivated` carries no "who triggered it" flag, so `TabActivation` records the tabId into `suppressTabs` before each of its own `tabs.update` (with a 1000ms safety timer in case the event is lost); an `onActivated` hitting the suppression set does not update `lastUserTabId`.
- **Tab-close landing spot:** when a scrape tab auto-closes (`onRemoved`), focus falls back to the user's last-clicked tab only if the closed tab **was that window's active tab at the time** (an `activeByWindow` Map records each window's latest active tab); if the target is in another window, additionally `chrome.windows.update({focused:true})` to focus it. With no valid target, Chrome's default behavior applies.
- **Persistence:** state (`lastUserTabId` + `activeByWindow`) is written to `chrome.storage.session` — an MV3 SW can suspend for minutes during page-context LLM calls, and in-memory state would be lost.
- Wrapped ops: `domScrollToBottom`, `domHover`, `hoverDismiss` (`withTabActivation(label, fn)` in `content-script.js` sends only `TAB_ACTIVATION_REQUEST`; under the sticky model there is no release message).

Key implementation detail: Chrome **silently** strips `"debugger"` from `optional_permissions` (it lives in the `kNonOptionalPermissions` set) — the `debugger` permission must be in required `permissions` and gated at runtime via the storage flag. The popup-window path (RC12/RC17) was removed in RC20; `closeScrapeTab` is now a thin idempotent wrapper over `chrome.tabs.remove`.

## 10. Long-HTML Budgets and Cleaning

Both wizard and autoFix prompts embed page HTML; three layers of defense control the scale (all born of real incidents):

1. **Tiered HTML cleaning** (`lib/dom-cleaner.js`): `cleanHtmlForLLM(rawHtml, annotations, budget)` first strips script/style/unrelated nodes and truncates long text and attributes, then degrades tier by tier under the budget; annotation-context extraction (`extractAnnotationContext`) keeps only the neighborhood of the target elements. The LLM sees cleaned structure, not raw outerHTML.
2. **Snapshot budgets** (`wizard-utils.js:truncateSnapshotForLLM`, default 30000 chars; `stripSnapshotsFromTestResult`): a testResult entering autoFix context is first stripped of per-step snapshots, then deduplicated per iteration (the RC9 incident: 750K-char snapshots bypassed the 30K budget and reached the prompt).
3. **Prompt element budgets** (`wizard-utils.js:formatElementsForPrompt`, RC54): when candidate-container element HTML is embedded one by one, a single element exceeding `RC54_MAX_ELEMENT_HTML_CHARS=30000` chars is truncated and tagged `[TRUNCATED]` (the opening tags + leading children already carry all the structural signal); once the total reaches `RC54_TOTAL_ELEMENTS_BUDGET_CHARS=200000`, remaining elements are tagged `[SKIPPED: element HTML budget exhausted]` — **the selectors are still listed** (sticky), so the LLM at least knows they exist (the RC54 incident: container candidates carried the raw outerHTML of the entire feed, inflating a single prompt to 756,464 tokens).

**The completion-budget chain:** `max_tokens = options.maxTokens ?? maxOutputTokens config ?? 8192` (`llm-client.js`). The Options page's `maxOutputTokens` (1024-131072, blank = 8192) is the global authoritative value.

**Non-retryable error classification** (details in §4.5): empty content + finish_reason=length is a deterministic failure, classified non-retryable directly instead of burning retry budget.

## 11. DOM-Obfuscation Adaptation (selector generation)

**File:** `extension/lib/selector-generator.js`

Modern component frameworks produce DOM loaded with auto-generated identifiers that change on every load; using them directly as anchors yields "works today, broken tomorrow" selectors:

- **Auto-id exclusion** (`AUTO_ID_RE`): `mount_0_0_*` (React root mount points, random suffix per load), `react-aria-:r3:` (React Aria useId), `headlessui-*`, `r_<digits>_` / `R_x:` — none of these patterns ever serve as anchors.
- **Hash-class detection** (`AUTO_CLASS_RE`): CSS-in-JS hash classes like `x` + a base36 string (e.g. `x9f619`) change on every build; recognized and skipped — note they are base36, not hex, and the regex matches letters+digits accordingly.
- **Leaf `:nth-of-type` retained:** when the walk reaches body without uniqueness, append `:nth-of-type(N)` only on the **leaf segment** (the clicked element itself, not a top-level shared segment) to disambiguate — this is a design trade-off, not an omission.
- **Anonymous-parent collapse:** when walking upward to build a path, **skip bare-tag segments** (pure `div` wrappers with no id/role/aria/data-/semantic class), bridging real anchor segments with the **descendant combinator** (space, not `>`) — tolerating changes in intermediate wrappers. A deeply nested portal marker once produced a 19-segment `> div >` chain (fragility score 115+); after the collapse the same element gets a 2-segment descendant selector. The upward walk stops once a document-unique partial selector is found.

**selector vs. domPath decoupling:** `generateSelector(el)` is short and optimized for execution (stops at uniqueness — a globally unique aria-label element yields a 1-segment path); `generateFullDomPath(el)` has no early stop, returns the full structural chain to body, and attaches no `:nth-of-type`; serving `clusterAnnotationsByContainer`'s context analysis (which once lost parent list-item context through short-circuiting, silently degrading multi-sample clustering to single-sample). Contract: `annotation.selector` for execution, `annotation.domPath` for analysis.

**LLM selector-generalization discipline** (DSL rules): prefer attribute **existence** (`a[data-kind]`) over literal-value matching; `FIELD COLLISION ON GENERALIZATION` — when a selector is generalized to match multiple entity kinds, the script must add disambiguation logic, or fields of different record kinds bleed into each other.

## 12. Configuration & Deployment

### 12.1 Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `SCRAPEWRIGHT_PORT` | `8765` | HTTP listen port |
| `SCRAPEWRIGHT_API_KEY` | `dev-key` | API auth key |

### 12.2 Chrome Storage

Data is stored in `chrome.storage.local`:

| Key | Description |
|-----|------|
| `services` | Service list |
| `jobQueue` | Job queue (max 100) |
| `executionLogs` | Execution history (max 100) |
| `llmConfig` | LLM configuration |
| `serverPort` | Host port |
| `debugLogs_YYYY-MM-DD` | Per-date debug logs |

### 12.3 Service Worker Keepalive

An MV3 Service Worker sleeps after 30s of inactivity. A `chrome.alarms.create('keepalive', { periodInMinutes: 0.4 })` wakes it every 24s to check connection state and reconnect on disconnect.

### 12.4 Distributed Deployment (Multi-Instance)

A single instance executes one job at a time (§14). The path to higher throughput is **parallel multi-instance deployment**: each instance gets its own Chrome Profile (cookies / login state), its own `host.js` process, and its own execution queue — **zero extension changes**, riding Chrome's native multi-process capability. Chrome MV3 caps each extension at 1 offscreen document (the script execution surface), so making the extension internally concurrent would mean rewriting the entire script execution path at very high cost; the multi-Profile approach sidesteps it entirely.

```
Scheduler
  ├── POST localhost:8760/api/v1/services/{name}/execute  → instance 0
  ├── POST localhost:8761/api/v1/services/{name}/execute  → instance 1
  └── POST localhost:8762/api/v1/services/{name}/execute  → instance 2
```

**Local multi-instance** (`deploy/scrapewright-manager.sh`):

```bash
vim deploy/config.yaml        # basePort=8760, baseDebugPort=9220, instances=5, headless=false
cd deploy && ./scrapewright-manager.sh start    # launch N instances
./scrapewright-manager.sh status
./scrapewright-manager.sh stop
```

| Key | Default | Description |
|-----|---------|-------------|
| `basePort` | `8760` | Starting HTTP port (instance N uses basePort+N) |
| `baseDebugPort` | `9220` | Starting Chrome remote-debugging port |
| `instances` | `5` | Number of instances |
| `headless` | `false` | Headless mode (set true when no login state is needed) |

**Docker / K8s** (`deploy/Dockerfile`, `deploy/k8s.yaml`):

```bash
docker build -f deploy/Dockerfile -t scrapewright .
kubectl apply -f deploy/k8s.yaml
kubectl scale deployment scrapewright --replicas=10
```

Each Pod runs 1 Chrome + 1 `host.js`, with `/health` as liveness/readiness probe. For login-required sites: in local deployment, start Chrome headed and log in once manually (cookies persist into the Profile); in K8s, pack the logged-in Profile as a PersistentVolume and mount it.

**Throughput reference:** 1 instance ≈ 2 jobs/min (2GB RAM); 5 ≈ 10 jobs/min (8GB); 10 ≈ 20 jobs/min (16GB); K8s 20 Pods ≈ 40 jobs/min.

## 13. Extension & Customization Guide

### 13.1 Adding a New `$` API

1. **sandbox.js** — add `window.$newApi = (...) => sendDomRequest('newAction', ...)`.
2. **content-script.js** — add a `case 'newAction':` handler and a `domNewAction()` implementation.
3. **wizard-utils.js** — update the API list in `SCRIPT_DSL_GUIDE`.
4. **wizard.js** — if the wizard should use it, update the relevant prompt.

### 13.2 Adding a New LLM Provider

1. **llm-client.js** — add a case in `getDefaultBaseUrl()`.
2. **options.js** — add an option in the provider dropdown.
3. If the provider is not OpenAI-compatible, adapt the `chat()` method.

### 13.3 Custom Step Templates

Add a new template to the `STEP_TEMPLATES` array in `wizard-utils.js`:

```javascript
{
  id: 'my-template',
  name: 'My Template',
  description: 'Template description',
  steps: [{ id, name, script, onSuccess, onFailure, maxIterations }]
}
```

### 13.4 Modifying the DOM Snapshot Strategy

`content-script.js:getDomSnapshot()` controls the full snapshot, `getCompressedSnapshot()` controls the compressed one. When modifying:
- Update the cleaning entry points in `lib/dom-cleaner.js` and the snapshot-budget functions in `lib/wizard-utils.js` (`truncateSnapshotForLLM` / `stripSnapshotsFromTestResult`) in sync.
- Preserve the `data-iframe-src` tagging convention (the LLM relies on it to recognize iframe content).

### 13.5 Debugging Tips

1. **Enable extension debug logging:** view structured `[component]`-prefixed logs in the Chrome DevTools Console.
2. **Inspect persisted logs:** run `chrome.storage.local.get(null, console.log)` in the Console to see all stored data.
3. **Manually test a script:** edit the script directly in wizard Phase 2.
4. **Export debug data:** the Options page can export service configs and execution history.

## 14. Known Limitations

| Limitation | Reason | Impact |
|------------|--------|--------|
| Only one job runs at a time | The Offscreen document uses a global tabIdStack | Concurrent requests queue |
| Cannot scrape cross-origin iframe content | Browser same-origin policy | Cross-origin content is invisible |
| Service Worker may sleep | MV3 constraint, 30s inactivity | Kept alive via alarm; extreme cases may lag |
| Auto-repair rounds are capped: wizard test loop at most 3 silent rounds, 1 with user feedback; runtime execution bounded by `config.maxRetries` (default 1) | Prevents infinite retry loops | Complex errors may need manual repair |
| No built-in login-state management | No cookie management feature | Pages requiring login need a manual login first |
| Default API key is `dev-key` | Development convenience | Production must set `SCRAPEWRIGHT_API_KEY` |
| IO-driven lazy-load stalls on background tabs | Chrome throttles renderer frame production for non-visible tabs | Lazy-load sites require `scrapewright throttle on` + Chrome restart (see §9, the renderer-throttling countermeasure stack) |

### 14.1 Robustness Audit Findings

- **Hovercard timing constants are tuned to portal-hovercard characteristics:** the 600px distance cap and the 1500ms no-signal early exit (§8.3/§8.4) come from the empirical distribution of portal-framework hovercards (600-1600ms mount, 400-500px below the cursor). Sites with farther or slower popovers need the caller to pass an explicit `popoverSel` (pinning path (a)), or risk being filtered out / early-exited.
- **The baseline outerHTML equality check** is blind to attribute-only re-renders — when the same element changes attributes but not text content, both the baseline diff and the stability sampling see "unchanged".
- **Scroll ops use a fixed network-settle wait** (`DEFAULT_SETTLE_MS=350ms` per-step sleep in `scroll-ops.js`): it does not wait for network idle, so appended content from slow APIs may be misjudged as feed exhaustion.
- **Hover polling serializes candidate outerHTML every 100ms tick:** with a huge candidate pool (large DOM + broad anchorSel) there is a performance cliff, backstopped only by the 3000ms default timeout.
- **Several graceful-degradation paths catch silently without logging** (baseline sampling, storage persistence, and other best-effort branches) — when debugging, cross-check the source to confirm these paths were not triggered.

## 15. Development & Contributing

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
./bin/scrapewright install           # install and start (default port 8765)
./bin/scrapewright install --port=9123  # pin to a custom port
./bin/scrapewright status            # service status + /health
./bin/scrapewright doctor            # full diagnostic
./bin/scrapewright restart           # restart the service after editing code
./bin/scrapewright logs -f           # tail the log
./bin/scrapewright uninstall         # stop and remove the service
```

The service starts automatically at user login; on crash the OS supervisor (systemd / launchd / scheduled task) restarts it within seconds. `scrapewright doctor` and `install` automatically detect and clean up legacy Native Messaging artifacts (manifest files / Windows registry key), printing a one-line terminal notice.

### Restarting after a code update

After editing extension files, reload the extension at `chrome://extensions/` (click the refresh icon on the extension card). After editing background-service code, run `./bin/scrapewright restart` to restart the service — no Chrome restart is needed, because HTTP is stateless: the extension's next `fetch()` hits the new process.

## 16. Solution Comparison and Positioning

AI-assisted web scraping / browser automation has four technical lanes; Scrapewright sits in the **client-side extension** lane, complementary to the other three. The core question is **whose browser**: Scrapewright reuses the user's daily Chrome (login state / cookies / fingerprint intact); the others typically use a separately deployed headless / server-side Chromium (clean profile).

| Lane | Representative products | Runs in | Login state |
|------|-------------------------|---------|-------------|
| Server-side headless scraping | Firecrawl, Crawl4AI, Spider | Chromium on a server | Requires Cookie / auth token injection |
| Server-side AI agent | Skyvern, Browser-use | Browser on a server | Automated login (form fill + CAPTCHA solving) |
| Developer coding-style | Claude Code + Puppeteer/Playwright | Developer's machine or CI | Manual (Cookie injection / login script) |
| Client-side extension (this project) | **Scrapewright** | The user's daily Chrome | **Natively reuses the user's logged-in session** |

### 16.1 vs CDP + AI coding (Claude Code / Cursor + Puppeteer/Playwright)

Developers can use AI coding tools to write Puppeteer/Playwright scrapers — the most flexible lane, but with a different working model:

| Dimension | Scrapewright | CDP + AI coding |
|-----------|--------------|-----------------|
| Usage | One-time AI wizard config → HTTP API service, reused long-term | Write / maintain code for every site |
| Who can use it | Non-technical users (wizard-style annotation + generation) | Developers only |
| Browser | User's daily Chrome (shared profile / login / fingerprint) | Headless or standalone Chromium (clean profile) |
| Login state | Directly reuses the user's logged-in session, zero extra cost | Needs Cookie injection / login scripts / CAPTCHA handling |
| Anti-bot detection | Extension content script; no `navigator.webdriver` footprint | CDP can be fingerprinted via `navigator.webdriver` and similar signals |
| Flexibility | Step-graph DSL (structured, covers most scraping logic) | Arbitrary code (most flexible; can intercept / mock network requests) |
| Maintainability | auto-fix (LLM repairs selectors and logic on script failure) | Code maintenance (AI can help, but human review needed) |
| Deployment | User's local Chrome + lightweight Node.js host | Server-side Node + Chromium |
| Concurrency | Single browser, serialized (scale out via multi-instance, §12.4) | Multiple headless instances in parallel |
| Best for | Low-frequency high-value jobs, login-required, non-technical users | Large-scale, flexible logic, dev teams, CI/CD integration |

Scrapewright's edge: configure once → reusable service + native login-state reuse + non-technical users + auto-fix self-healing.
CDP + AI coding's edge: fully flexible code + Git versioning + server-side concurrency + fine-grained network-layer control.

### 16.2 vs sibling AI scraping products

| Product | Type | Runs in | Login state | LLM role | Core difference vs Scrapewright |
|---------|------|---------|-------------|----------|---------------------------------|
| [Firecrawl](https://www.firecrawl.dev/) | Hosted API | Cloud server | Cookie / token required | LLM extracts structured data | We reuse the user's login + generate executable step-graph scripts (not just HTML→Markdown); local deploy (data never leaves the machine) |
| [Crawl4AI](https://github.com/unclecode/crawl4ai) | Open-source Python library | Server (Playwright) | Cookie passthrough supported | LLM extracts as Markdown | We're a client-side extension + AI wizard (non-technical users vs Python developers) |
| [Skyvern](https://www.skyvern.com/) | AI agent | Server | Automated login (form + CAPTCHA) | LLM drives every step | We're a configurable HTTP service (vs interactive agent); reuse real login state (vs simulated login) |
| [Browser-use](https://browser-use.com/) | AI agent | Server | Manual | LLM drives the browser in real time | We configure once into a repeatable service (vs interactive driving every time) |
| [AgentQL](https://agentql.com/) | Smart selector API | Server | Handled separately | LLM picks elements | We provide full step-graph orchestration + auto-fix (vs single-point selector intelligence) |

> Based on each product's 2025–2026 public docs; these products iterate fast — cross-check the current state.

### 16.3 Honest positioning

**Good at:** login-required scraping (enterprise intranets, paid content, personal account data — zero login cost is the biggest differentiator: Skyvern has to simulate login, Firecrawl needs Cookie injection, CDP needs a login script); non-technical users customizing scrapes (visual annotation + HTTP API service); low-frequency high-value queries (AI Q&A capture, org/person lookups, knowledge graphs); complex page structures (iframe nesting, dynamic loading, streaming content).

**Not good at:** large-scale high-concurrency scraping (10k+ URLs, single-browser bottleneck — use Firecrawl / Crawl4AI / multi-instance CDP); 24×7 unattended operation (depends on the user's Chrome — use a server-side approach); fine-grained network-layer control (intercept / mock, custom headers — use CDP).

**One-line positioning:** not a general-purpose crawler engine, but an "AI scraping assistant inside your (or your team's) browser" — turning "open browser → log in → operate → extract" into an HTTP service callable by external programs.
