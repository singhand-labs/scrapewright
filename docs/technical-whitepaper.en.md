# Scrapewright — System Technical Whitepaper

> Version: 0.1.0 | Last updated: 2026-06-09 · [中文版](./technical-whitepaper.md)

## 1. System Overview

Scrapewright is an LLM-driven web data extraction platform composed of a Chrome Extension (Manifest V3) and a Node.js Native Messaging Host. Users describe a scraping need in natural language; an LLM automatically analyzes the target page structure, generates a scraping script, executes it inside a real browser, and returns structured data.

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
- Node.js >= 18 (Native Messaging Host)
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
│                   Native Messaging Host                          │
│                     (Node.js process)                            │
│                                                                  │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────┐   │
│  │ HTTP Server  │  │ Native Msg   │  │ Extension Poll       │   │
│  │ (API router) │  │ (stdin/out)  │  │ (long-poll channel)  │   │
│  └──────┬───────┘  └──────┬───────┘  └──────────┬───────────┘   │
│         └─────────────────┼──────────────────────┘               │
│                           │                                      │
│              sendToExtension() — unified send                    │
│              handleIncomingMessage() — unified receive           │
└───────────────────────────┼──────────────────────────────────────┘
                            │ Chrome Native Messaging / HTTP long-poll
┌───────────────────────────▼──────────────────────────────────────┐
│                   Chrome Extension (Manifest V3)                 │
│                                                                  │
│  ┌──────────────────────────────────────────────────────────────┐│
│  │              background.js (Service Worker)                  ││
│  │  ExecutionQueue ── ServiceRegistry ── LLMClient              ││
│  │  StepOrchestrator ── OffscreenExecutor ── AutoFix            ││
│  │  LongPollingClient ── NativeMessagingPort                    ││
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

### 2.2 Two Communication Channels

Two channels connect the Host and the extension; the active one is chosen automatically:

```
External program
    |
    | HTTP POST /api/v1/services/{name}/execute
    v
+------------------+                          +------------------+
|  host.js         |  Native Messaging (stdin |  background.js   |
|  (Node.js)       |  /stdout, Chrome-launched)| (Service Worker)|
|                  |                          +--------+---------+
|  or HTTP long-   |                          |                 |
|  polling:        | <---- HTTP long-poll ----|  Auto-fallback  |
|  /extension/poll |                          |                 |
|  /extension/resp |                          |                 |
+------------------+                          +--------+---------+
                                                       |
                                                       | chrome.tabs.sendMessage
                                                       v
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

| Channel | Trigger | Direction | Protocol |
|---------|---------|-----------|----------|
| Native Messaging | Chrome auto-launches the Host | stdin/stdout pipe | length-prefixed JSON |
| HTTP long-poll | Host started manually | extension polls actively | HTTP GET/POST |

**Selection logic** (`background.js:initCommunication`):
1. Probe the HTTP port first (3s timeout) — if a Host is already running, use long-polling.
2. HTTP unavailable → try Native Messaging (`chrome.runtime.connectNative`).
3. Both fail → reconnect on a timer (25s keepalive alarm).

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

native-host/              # Node.js Native Messaging Host
  host.js                 # HTTP server — Native Messaging + HTTP long-polling dual transport
  lib/
    native-messaging.js   # Length-prefixed JSON codec (UTF-8 safe)
  install-host.sh         # Linux / macOS installer
  install-host.ps1        # Windows installer
  host.cmd                # Windows launcher wrapper
  test/                   # Tests
```

### 2.5 Chrome MV3 Constraints

Chrome Manifest V3 imposes several hard constraints that directly shaped the design:

| Constraint | Impact | Mitigation |
|------------|--------|------------|
| Service worker cannot run an HTTP server | Extension can't expose an API directly | Add a Node.js Native Messaging Host as the HTTP bridge |
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

### 4.7 Native Messaging

**File:** `native-host/lib/native-messaging.js`

Chrome Native Messaging protocol implementation:

```
Encoding: 4-byte little-endian length + UTF-8 JSON byte stream
Decoding: state buffer + frame splitting + JSON.parse
```

**Defenses:**
- A length field over 10MB is treated as corrupt; the buffer is discarded and reset.
- On JSON.parse failure, the corrupt frame is skipped without interrupting subsequent messages.

### 4.8 DebugLogger

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

Triggered automatically when a script execution fails:

```
StepOrchestrator throws an error (with stepId, snapshot)
  → tryAutoFixStep(service, stepId, error)
    → capture the current page's DOM snapshot (compressed mode)
    → build the repair prompt (DSL guide + error + snapshot + original script + annotations)
    → LLM produces a repaired script
    → replace the failing step's `script` field
    → save the service → retry execution
```

**Limit:** at most `maxRetries` retries (default 2). Triggered only for `ELEMENT_NOT_FOUND` and `SCRIPT_ERROR` error types.

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

Message format between the Host and the extension:

```typescript
// Request
interface HostMessage {
  type: 'EXECUTE' | 'GET_JOB_STATUS' | 'GET_JOBS' | 'GET_SERVICES' | 'CANCEL_JOB';
  reqId: number;        // request id
  serviceName?: string;
  input?: object;
  jobId?: string;
}

// Response
interface ExtensionResponse {
  reqId: number;
  success: boolean;
  jobId?: string;
  job?: Job;
  services?: Service[];
  error?: string;
}
```

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
# Run Native Host tests
cd native-host && npm test

# Run a single test file
cd native-host && node --test test/host.test.js

# Run extension tests (needs jsdom from the repo root)
cd extension && node --test test/*.test.js lib/*.test.js
```

### Starting the Host manually (custom port)

```bash
cd native-host && node host.js --port=19880
```

In manual mode, the extension auto-falls-back to HTTP long-polling; make sure the port on the extension Options page under **Server Configuration** matches the `--port` argument.

### Restarting after a code update

After editing extension files, reload the extension at `chrome://extensions/` (click the refresh icon on the extension card). After editing Native Host code, restart the Host process.

**Windows (PowerShell, admin):**
```powershell
# Kill the old process
taskkill /F /IM node.exe
# Close and restart Chrome
taskkill /F /IM chrome.exe
start chrome
```

**Linux / macOS:**
```bash
# Kill the old process
pkill -f "node.*host.js"
# Restart Chrome or reload the extension
```

After restarting Chrome, refresh the extension at `chrome://extensions/`; Chrome will launch the Native Host with the new code. In manual-start mode, just `Ctrl+C` the current `node host.js` and run it again.
