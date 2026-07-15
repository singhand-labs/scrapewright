# Scrapewright

**LLM-powered web scraping platform**

**English** | [简体中文](./README.zh-CN.md)

[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg)](./LICENSE)
![Node](https://img.shields.io/badge/Node.js-%3E%3D18-green)
![Chrome](https://img.shields.io/badge/Chrome-MV3-brightgreen)
![Platform](https://img.shields.io/badge/Platform-macOS%20%7C%20Linux%20%7C%20Windows-lightgrey)

> Developed and maintained by [Hunan Singhand Intelligent Data Technology Co.,Ltd](https://www.singhand.com) · Released under [**GPLv3**](./LICENSE)

Scrapewright tightly couples large language models (LLMs) with browser automation: describe what you want to scrape in natural language, and the system automatically analyzes the target page, generates the scraping script, executes it, and returns structured data. Built as a Chrome Extension (Manifest V3) plus a Node.js Native Messaging Host, it exposes a standard HTTP API that drops cleanly into any backend system, data pipeline, or automation workflow.

## Table of Contents

- [Background: Why Scrapewright](#background-why-scrapewright)
- [Core Features](#core-features)
- [System Requirements](#system-requirements)
- [Installation](#installation) · [Startup Modes](#startup-modes) · [Troubleshooting](#troubleshooting--faq)
- [HTTP API](#http-api) · [Script DSL](#script-dsl)
- [Project Structure](#project-structure) · [Communication Architecture](#communication-architecture) · [Development](#development)
- [Comparison with Other Solutions](#comparison-with-other-solutions)
- [Distributed Deployment](#distributed-deployment) · [Technical Architecture](#technical-architecture)
- [Roadmap](#roadmap)
- [Copyright & License](#copyright--license)

## Background: Why Scrapewright

Traditional web scraping tools (Scrapy, Puppeteer, BeautifulSoup, etc.) share several pain points:

1. **High development cost** — every target site needs hand-written selectors, pagination handling, and anti-bot countermeasures. Maintenance cost keeps accumulating as sites change.
2. **Painful dynamic pages** — SPA, nested iframes, and JavaScript-rendered content are hard to reach via plain HTTP requests.
3. **Poor reusability** — scraping scripts are typically bespoke per site; they don't transfer to structurally similar pages.
4. **No unified interface** — different scraping jobs have no standardized input/output shape, which makes orchestration and scaling hard.

How Scrapewright answers each:

- **AI-driven** — describe *what* you want; the LLM analyzes page structure, generates the scraping script, and self-repairs on errors.
- **Real browser environment** — runs as a Chrome extension inside a full browser, with first-class JavaScript rendering, iframe traversal, and dynamic loading.
- **Standardized API** — every scraping service is callable through a uniform HTTP API, with JSON Schema constraints on both input and output.
- **Visual wizard** — a 7-step flow takes you from describing the requirement to a tested deployment, no code required.


## Core Features

| Feature | Description |
|---------|-------------|
| **AI script generation** | Provide the target URL + a natural-language description; the LLM analyzes the page and generates a scraping script |
| **Multi-step orchestration** | Conditional branches, loops, pagination, and per-detail-page crawling are first class |
| **Cross-iframe scraping** | Automatically searches and scrapes same-origin iframe content (e.g. nested announcement pages on government sites) |
| **Deep detail-page scraping** | The `$openTab` API opens each list item's detail page in turn and extracts structured data |
| **AI auto-repair** | On execution failure, captures a DOM snapshot, analyzes the error, and asks the LLM to rewrite the script before retrying |
| **Element intent annotation** | Visually annotate page elements with intent (click / type / extract / wait), specify wait conditions (appear / disappear / content-stable) and output field mappings, so the LLM consumes your intent directly instead of guessing |
| **Service management** | Import/export, enable/disable, edit existing services, and one-click export of Markdown API docs (handy for sharing or feeding to AI agents) |
| **Unified ops CLI** | `./bin/scrapewright` (setup / doctor / status / restart / logs / id) auto-detects the extension ID — no manual transcription |
| **Async execution queue** | Concurrent requests queue automatically and return asynchronously; well suited to batch scraping |

## System Requirements

- Chrome browser (latest stable)
- Node.js >= 18

## Installation

### 1. Load the Chrome Extension

1. Open Chrome and navigate to `chrome://extensions/`
2. Toggle on **Developer mode** in the top-right corner
3. Click **Load unpacked** and select the project's `extension/` directory
4. After it loads, note the **Extension ID** shown on the extension card (e.g. `dmbnejooocdfjmnebpglhedhfcgncgdl`) — you'll need it for the Native Host install

### 2. Install the Native Messaging Host

> **Recommended: one-line install.** The unified CLI at the project root auto-detects the extension ID from Chrome (no need to copy from `chrome://extensions/`), installs the Native Host, and self-checks:
> ```bash
> ./bin/scrapewright setup --auto
> ```

`scrapewright` command overview (full text at `./bin/scrapewright help`):

| Command | Purpose |
|---------|---------|
| `scrapewright setup --auto` | Auto-detect extension ID + install + self-check (first choice on a new machine) |
| `scrapewright status` | Show host process, connection state, and whether the ID matches the manifest |
| `scrapewright doctor` | Full diagnostic (node / manifest / wrapper / path-drift) + `/health` probe |
| `scrapewright restart` | Kill the host; in native mode, click **Reconnect** in the extension's Options to let Chrome relaunch it (use after editing host.js) |
| `scrapewright logs -f` | Tail the host log in real time |
| `scrapewright id` | Detect the current extension ID and check for drift vs the manifest |
| `scrapewright uninstall` | Uninstall the Native Host |

> On Windows use `.\bin\scrapewright.cmd ...` (same commands). The `install-host.sh` / `install-host.ps1` scripts below are the lower-level primitives the CLI calls internally — reach for them directly in CI or when you need manual control.

The Native Messaging Host is a Node.js process that bridges the HTTP API and the Chrome extension.

**Linux / macOS:**

```bash
cd native-host
npm install
./install-host.sh <extension-id>
```

Example:
```bash
./install-host.sh dmbnejooocdfjmnebpglhedhfcgncgdl
```

**Windows (PowerShell):**

```powershell
cd native-host
npm install
.\install-host.ps1 -ExtensionId "<extension-id>"
```

> **Note:** `<extension-id>` must be the actual Extension ID; wildcards are not supported by Chrome. Find it on `chrome://extensions/`.

The installer registers the Native Messaging Host with the system:
- Linux / macOS: writes `~/.config/google-chrome/NativeMessagingHosts/com.scrapewright.host.json`
  (macOS: `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.scrapewright.host.json`)
- Windows: writes registry key `HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.scrapewright.host`

> **Important:** The Native Messaging manifest stores the **absolute path** to `host-launcher`. Make sure to run the installer from the project directory you'll actually use for development/running. If you later **move or rename the project directory** (e.g. extracting from a downloaded `scrapewright-master` archive into a permanent location), you must re-run `./install-host.sh <extension-id>` (Windows: `.\install-host.ps1 -ExtensionId <id>`). Otherwise Chrome keeps launching the stale Host from the old directory, and you'll see "Native Messaging never connects, extension silently falls back to long-polling". Run `./install-host.sh --doctor` (Windows: `.\install-host.ps1 -Doctor`) to self-check.

After installation, **restart Chrome** (or click **Reconnect** in the Native Host Status card on the extension's Options page).

### 3. Configure the LLM

1. Click the extension icon → click **Options** to open the config page
2. Under **LLM Configuration**, fill in:
   - **Provider** — pick an LLM provider (OpenAI / Moonshot / Kimi / Anthropic / GLM)
   - **Model** — model name (e.g. `gpt-4o`, `kimi-for-coding`, `glm-5.1`)
   - **API Key** — your API key
   - **Base URL** (optional) — custom API endpoint, useful for corporate proxies or OpenAI-compatible gateways. Must include the path prefix (e.g. `https://api.openai.com/v1`), not just the domain
3. Click **Save**

### 4. Create a Scraping Service

On the Options page click **+ New Service** to enter the AI wizard (7 steps):

| Step | Description |
|------|-------------|
| **Step 1: Target URL** | Enter the target site URL (press Enter to advance) |
| **Step 2: Describe Needs** | Describe the scraping requirement in natural language; click **Research** (or Ctrl+Enter) and the AI analyzes the page and generates a script |
| **Step 3: Annotate Elements** | If the AI needs help, visually annotate page elements; once done, the AI optimizes the script using your annotations |
| **Step 4: Service Name & Script** | Name the service; review and **edit** the AI-generated script |
| **Step 5: I/O Schema & Test Input** | Confirm input/output parameter shapes (JSON Schema) and edit the test input data |
| **Step 6: Execute Test** | Watch the live execution log (open page → load → execute → success/failure) |
| **Step 7: Results** | Review test results. On failure, choose **Auto-Fix** (AI self-repair) or **Deploy Anyway** (deploy despite the error) |

### 5. Manage Services

In the **Services** section of the Options page:

- **Enable / Disable** — toggle a service on or off
- **Edit** — return to the wizard to edit (pre-filled with the existing config)
- **Export** — export a single service as JSON
- **Export All** — export every service
- **Import** — import services from JSON (duplicates are skipped automatically)
- **Delete** — delete a service

The bottom of the Options page shows **Execution History** (the most recent 20 runs) with timestamp, service name, and success/failure status.

## Startup Modes

The Host supports two communication modes: **Native Messaging** (Chrome auto-launches it) and **HTTP long-polling** (you start it manually). The two modes auto-switch; no extra configuration is needed.

### Mode A: Native Messaging (recommended)

After step 2 of installation, Chrome automatically connects to the Host via Native Messaging on startup — nothing to do manually.

### Mode B: Manual Start (HTTP long-polling)

If Native Messaging is unavailable (not installed, install failed, or you want manual control), start the Host by hand and the extension will fall back to HTTP long-polling automatically:

```bash
# Default port 8765
cd native-host && node host.js

# Custom port (must match the port set on the extension Options page under Server Configuration)
cd native-host && node host.js --port=19880

# Or via environment variable
SCRAPEWRIGHT_PORT=19880 node host.js
```

On startup you'll see:
```
[ScrapewrightHost] Startup diagnostics:
  Mode: HTTP Long-Polling (manual start)
  Extension should connect to: http://localhost:19880/api/v1/extension/poll

Scrapewright host listening on port 19880
  Waiting for extension to connect via long-polling...
  Ensure extension settings use port 19880
```

> **Note:** In manual mode, make sure the port on the extension Options page under **Server Configuration** matches the `--port` argument. The extension auto-falls-back to long-polling whenever Native Messaging drops.

## Troubleshooting / FAQ

**Symptom:** The extension reports "Native host has exited", Native Messaging never works, or the Host log shows `native stdin closed WITHOUT ever receiving an extension message` / `Falling back to poll mode`.

1. **Most common cause: the project directory was moved.** The Native Messaging manifest stores the **absolute path** at install time. If you relocated the project from `~/Downloads/scrapewright-master` to `~/projects/scrapewright`, Chrome is still launching the stale `host.js` from the old location; it's incompatible with the new extension and stdin closes immediately. Fix: re-run `./install-host.sh <extension-id>` (Windows: `.\install-host.ps1 -ExtensionId <id>`) from the new directory.

2. **Run the diagnostic:**
   ```bash
   cd native-host && ./install-host.sh --doctor        # macOS / Linux
   .\install-host.ps1 -Doctor                          # Windows
   ```
   Pay attention to the `path points into current host dir` check — it compares the manifest path to the script's current directory, prints a fix command on drift, and runs a wrapper smoke test to verify node + host.js initialize cleanly.

3. **Tail the Host log:**
   ```bash
   tail -f ~/Library/Logs/scrapewright/host.log      # macOS
   tail -f ~/.cache/scrapewright/host.log            # Linux
   Get-Content -Wait "$env:LOCALAPPDATA\scrapewright\host.log" -Tail 20   # Windows
   ```
   A healthy connection shows `mode: native messaging (Chrome-launched)` *not* followed by "closed WITHOUT ever receiving". Boot crashes (before the logger initializes) land in `startup-error.log` next to `host.log` — that's the real stack trace behind Chrome's opaque "Native host has exited".

4. **When you don't want to restart Chrome:** click **Reconnect** in the **Native Host Status** card on the extension's Options page (lighter than restarting Chrome). After editing Host code, you still need to restart Chrome or reload the extension.

## HTTP API

All execution is **asynchronous**. A call returns a `jobId` immediately; fetch the result via the status or wait endpoint. Concurrent requests queue automatically; only one job runs at a time.

### Configuration

| Parameter | Default | Description |
|-----------|---------|-------------|
| `--port=N` | `8765` | HTTP listen port (CLI argument) |
| `SCRAPEWRIGHT_PORT` | `8765` | HTTP listen port (env var; CLI argument takes precedence) |
| `SCRAPEWRIGHT_API_KEY` | `dev-key` | API authentication key |

You can also change the port dynamically from the extension Options page under **Server Configuration** (applies immediately, no restart needed).

### Authentication

All external API requests must carry the `X-API-Key` header.

### Endpoints

#### Submit a job

```
POST /api/v1/services/{service-name}/execute
```

Request body:
```json
{ "input": { "query": "hello" } }
```

Response (202 Accepted):
```json
{
  "success": true,
  "jobId": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
  "status": "queued",
  "queuePosition": 1
}
```

> Concurrent requests queue automatically; `queuePosition` is your place in line (0 = currently executing).

#### Wait for result (blocking)

```
GET /api/v1/jobs/{jobId}/wait?timeout=120
```

Long-polls until the job completes. `timeout` is in seconds (max 300, default 120).

Response (once the job finishes):
```json
{
  "success": true,
  "job": {
    "id": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
    "status": "completed",
    "result": { "thinking": "...", "answer": "..." },
    "error": null,
    "queuePosition": 0,
    "createdAt": 1717700000000,
    "startedAt": 1717700001000,
    "completedAt": 1717700015000
  }
}
```

#### Query job status

```
GET /api/v1/jobs/{jobId}
```

Same response shape as `/wait`, but non-blocking — returns the current state immediately.

#### Cancel a job

```
POST /api/v1/jobs/{jobId}/cancel
```

Only queued jobs (`status: "queued"`) can be cancelled. (Cancellation of in-flight jobs is on the roadmap.)

#### List all jobs

```
GET /api/v1/jobs
```

#### List all services

```
GET /api/v1/services
```

Response:
```json
{
  "success": true,
  "services": [
    {
      "name": "baidu-chat",
      "displayName": "Baidu AI Chat",
      "targetUrl": "https://chat.baidu.com",
      "enabled": true,
      "inputSchema": { ... },
      "outputSchema": { ... }
    }
  ]
}
```

#### Health check

```
GET /health
```

No API key required. Use it for load-balancer, K8s, or scheduler liveness probes.

Response:
```json
{
  "status": "ok",
  "extensionConnected": true,
  "queueLength": 0,
  "queueRunning": false,
  "uptime": 3600
}
```

| Field | Description |
|-------|-------------|
| `status` | `"ok"` = extension connected; `"degraded"` = extension not connected |
| `extensionConnected` | Whether the extension is connected via Native Messaging or long-polling |
| `queueLength` | Number of queued jobs |
| `queueRunning` | Whether a job is currently executing |
| `uptime` | Host process uptime in seconds |

### curl example

```bash
# Submit a job
JOB_ID=$(curl -s -X POST http://localhost:8765/api/v1/services/my-service/execute \
  -H "X-API-Key: dev-key" \
  -H "Content-Type: application/json" \
  -d '{"input": {"query": "hello"}}' | jq -r '.jobId')

echo "Job ID: $JOB_ID"

# Wait for the result (blocks until completion)
curl -s "http://localhost:8765/api/v1/jobs/$JOB_ID/wait?timeout=60" \
  -H "X-API-Key: dev-key" | jq .

# Or poll status manually
curl -s "http://localhost:8765/api/v1/jobs/$JOB_ID" \
  -H "X-API-Key: dev-key" | jq '.job.status'
```

### Job states

| State | Description |
|-------|-------------|
| `queued` | Waiting in the queue |
| `running` | Currently executing |
| `completed` | Finished successfully; result is in the `result` field |
| `failed` | Failed; error details in the `error` field |
| `cancelled` | Cancelled |

### Error types

| Error | Description |
|-------|-------------|
| `ELEMENT_NOT_FOUND` | Target element not found; the AI will attempt to auto-repair the script |
| `SCRIPT_ERROR` | Script execution error; the AI will attempt to auto-repair the script |
| `SCRIPT_TIMEOUT` | Script execution timed out (default 60s) |
| `LOGIN_REQUIRED` | The target site requires login; the user must log in manually and retry |
| `Extension timeout` | Host cannot reach the extension — verify the extension is loaded and the port matches |

## Script DSL

User scripts run inside a sandboxed iframe and interact with the target page through async APIs:

| API | Description |
|-----|-------------|
| `$(selector)` | Wait for an element to appear (up to 30s); returns element data |
| `$click(selector)` | Click an element |
| `$type(selector, text)` | Type text (supports INPUT, TEXTAREA, contenteditable) |
| `$extract(selector, attr?)` | Extract text content or an attribute value |
| `$wait(selector, delayMs?)` | Wait for an element to appear, with optional delay |
| `$exists(selector, timeoutMs?)` | Check whether an element exists (recommended for polling) |
| `$check(selector, property)` | Read an element property (e.g. `checked`) |
| `$list(selector)` | Get all matching elements (including same-origin iframes) |
| `$count(selector)` | Count matching elements |
| `$openTab(url, fn)` | Open a new tab and run a function body in it; returns the result |

Scripts also have access to injected context:
- `__input__` — parameters passed in by the external caller
- `__stepResults__` — a map of return values from all steps, keyed by step id
- `__lastResult__` — the previous step's return value

## Project Structure

```
extension/                # Chrome Extension (Manifest V3)
  background.js           # Service Worker — execution queue, script orchestration, retry, AI auto-fix, long-poll client
  content-script.js       # Content script — DOM op proxy, element annotation, page snapshot
  sandbox.html/js         # Sandbox page — eval/new Function runs here (MV3 CSP requirement)
  wizard.html/js/css      # 7-step AI wizard — service create/edit flow
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

## Communication Architecture

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

The Host and extension communicate over two channels and switch automatically:
1. **Native Messaging** — used when Chrome auto-launches the Host (stdin/stdout pipe, low latency)
2. **HTTP long-polling** — used when the Host is started manually (the extension polls `GET /api/v1/extension/poll` and posts responses to `POST /api/v1/extension/response`)

## Development

```bash
# Run Native Host tests
cd native-host && npm test

# Run a single test file
cd native-host && node --test test/host.test.js

# Start the Host manually (custom port)
cd native-host && node host.js --port=19880
```

After editing extension files, reload the extension at `chrome://extensions/` (click the refresh icon on the extension card). After editing Native Host code, restart the Host process.

### Restarting after a code update

To pick up code changes, restart the Host process:

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

After restarting Chrome, refresh the extension at `chrome://extensions/`; Chrome will launch the Native Host with the new code.

In manual-start mode, just `Ctrl+C` the current `node host.js` and run it again.

## Comparison with Other Solutions

AI-assisted web scraping / browser automation falls into four technical lanes. Scrapewright sits in the **client-side extension** lane, complementary to the other three rather than a replacement.

> **Honest premise:** every approach needs a browser. The difference is **whose browser** — Scrapewright reuses the user's daily Chrome (with login state / cookies / fingerprint intact); the others typically use a separately deployed headless / server-side Chromium (clean profile).

### The four lanes

| Lane | Representative products | Runs in | Login state |
|------|-------------------------|---------|-------------|
| **Server-side headless scraping** | Firecrawl, Crawl4AI, Spider | Chromium on a server | Requires Cookie / auth token injection |
| **Server-side AI agent** | Skyvern, Browser-use | Browser on a server | Automated login (form fill + CAPTCHA solving) |
| **Developer coding-style** | Claude Code + Puppeteer/Playwright | Developer's machine or CI | Manual (Cookie injection / login script) |
| **Client-side extension (this project)** | **Scrapewright** | The user's daily Chrome | **Natively reuses the user's logged-in session** |

### vs CDP + AI coding (Claude Code / Cursor + Puppeteer/Playwright)

Developers can use AI coding tools like Claude Code to write Puppeteer/Playwright scrapers for a target site. That's the most flexible option, but the working mode and fit differ:

| Dimension | Scrapewright | CDP + AI coding |
|-----------|--------------|-----------------|
| **Usage** | One-time AI wizard config → HTTP API service, reused long-term | Write / maintain code for every site |
| **Who can use it** | Non-technical users (wizard-style annotation + generation) | Developers only |
| **Browser** | User's daily Chrome (shared profile / login / fingerprint) | Headless or standalone Chromium (clean profile) |
| **Login state** | Directly reuses the user's logged-in session, zero extra cost | Needs Cookie injection / login scripts / CAPTCHA handling |
| **Anti-bot detection** | Extension content script; no `navigator.webdriver` footprint | CDP can be fingerprinted via `navigator.webdriver` and similar signals |
| **Flexibility** | Step-graph DSL (structured, covers most scraping logic) | Arbitrary code (most flexible; can intercept / mock network requests) |
| **Maintainability** | auto-fix (LLM repairs selectors and logic on script failure) | Code maintenance (Claude Code can help, but human review needed) |
| **Deployment** | User's local Chrome + lightweight Node.js host | Server-side Node + Chromium |
| **Concurrency** | Single browser, serialized (scale out via multi-instance) | Multiple headless instances in parallel |
| **Best for** | Low-frequency high-value jobs, login-required, non-technical users | Large-scale, flexible logic, dev teams, CI/CD integration |

**Scrapewright's edge:** configure once → reusable service (not "write code every time") + native login-state reuse + non-technical users + auto-fix self-healing.
**CDP + AI coding's edge:** fully flexible code + Git versioning + server-side concurrency + fine-grained network-layer control.

### vs sibling AI scraping products

| Product | Type | Runs in | Login state | LLM role | Core difference vs Scrapewright |
|---------|------|---------|-------------|----------|---------------------------------|
| **[Firecrawl](https://www.firecrawl.dev/)** | Hosted API | Cloud server | Cookie / token required | LLM extracts structured data | We reuse the user's login + generate executable step-graph scripts (not just HTML→Markdown extraction); local deploy (data never leaves the machine) |
| **[Crawl4AI](https://github.com/unclecode/crawl4ai)** | Open-source Python library | Server (Playwright) | Cookie passthrough supported | LLM extracts as Markdown | We're a client-side extension + AI wizard (non-technical users vs Python developers) |
| **[Skyvern](https://www.skyvern.com/)** | AI agent | Server | Automated login (form + CAPTCHA) | LLM drives every step | We're a configurable HTTP service (vs interactive agent); reuse real login state (vs simulated login) |
| **[Browser-use](https://browser-use.com/)** | AI agent | Server | Manual | LLM drives the browser in real time | We configure once into a repeatable service (vs interactive driving every time) |
| **[AgentQL](https://agentql.com/)** | Smart selector API | Server | Handled separately | LLM picks elements | We provide full step-graph orchestration + auto-fix (vs single-point selector intelligence) |

> The above is based on each product's 2025–2026 public docs. These products iterate fast — cross-check the current state.

### Where Scrapewright honestly fits

**Good at (recommended):**
- **Login-required scraping** — enterprise intranets, paid content platforms, personal account data. Your already-logged-in browser just works, zero login cost (this is the biggest differentiator: Skyvern has to simulate login, Firecrawl needs Cookie injection, CDP needs a login script).
- **Non-technical users customizing scrapes** — AI wizard (visual element intent annotation) + HTTP API service, no code.
- **Low-frequency high-value queries** — AI Q&A capture, organization / person lookups, knowledge graph construction. Not mass crawling — automation of specific queries.
- **Complex page structures** — iframe nesting (e.g. government announcements), dynamic loading, streaming content (AI answers via `$waitForStable`).

**Not good at (use something else):**
- **Large-scale high-concurrency scraping** (10k+ URLs) — single-browser bottleneck; use Firecrawl / Crawl4AI / multi-instance CDP.
- **24x7 unattended** — depends on the user's Chrome running; use a server-side approach.
- **Fine-grained network-layer control** — intercept / mock requests, custom headers; use CDP (Puppeteer / Playwright).

**One-line positioning:** Scrapewright is not a general-purpose crawler engine — it's an **"AI scraping assistant inside your team's browser"**. It turns the repetitive "open browser → log in → operate → extract" workflow into an HTTP service callable by external programs. It shines for login-required, low-frequency high-value scraping that non-technical users also want to do.

## Distributed Deployment

Scrapewright supports parallel multi-instance deployment; each instance uses an independent Chrome Profile for complete isolation. The core idea: **zero extension changes** — N independent Chrome instances, each with its own Profile and port.

### Architecture

```
Scheduler
  ├── POST localhost:8760/api/v1/services/{name}/execute  → instance 0
  ├── POST localhost:8761/api/v1/services/{name}/execute  → instance 1
  └── POST localhost:8762/api/v1/services/{name}/execute  → instance 2
```

Each instance has its own Chrome Profile (cookies / login state), its own `host.js` process, and its own execution queue.

### Why not make the extension itself concurrent?

Chrome MV3 limits each extension to **1 offscreen document** (the script execution surface) — a hard platform-level cap. Making the extension internally concurrent would require rewriting the entire script execution path at very high cost. The multi-Profile approach instead uses Chrome's native multi-process capability: every instance is fully independent, with no extension code changes at all.

### Local multi-instance deployment

```bash
# 1. Edit the config
vim deploy/config.yaml

# 2. Start 5 instances
cd deploy && ./scrapewright-manager.sh start

# 3. Check status
./scrapewright-manager.sh status

# 4. Stop all instances
./scrapewright-manager.sh stop
```

Config keys (`deploy/config.yaml`):

| Key | Default | Description |
|-----|---------|-------------|
| `basePort` | `8760` | Starting HTTP port (instance N uses basePort+N) |
| `baseDebugPort` | `9220` | Starting Chrome remote debugging port |
| `instances` | `5` | Number of instances |
| `headless` | `false` | Headless mode (set to true when no login state is needed) |

### Docker / K8s deployment

```bash
# Build the image
docker build -f deploy/Dockerfile -t scrapewright .

# K8s deployment
kubectl apply -f deploy/k8s.yaml

# Scale to 10 instances
kubectl scale deployment scrapewright --replicas=10
```

In K8s each Pod runs 1 Chrome + 1 `host.js`, with the `/health` endpoint serving as liveness and readiness probe. The scheduler reaches the service via `scrapewright.default.svc.cluster.local:8765`.

### Login-required sites

- **Local deployment:** start Chrome in headed mode → manually log in to the target site → cookies persist into the Profile directory
- **K8s deployment:** pack the logged-in Profile as a PersistentVolume and mount it into the Pod

### Throughput reference

| Instances | Throughput | Memory |
|-----------|------------|--------|
| 1 | ~2 jobs/min | 2GB |
| 5 | ~10 jobs/min | 8GB |
| 10 | ~20 jobs/min | 16GB |
| K8s 20 Pods | ~40 jobs/min | Per-node |

## Technical Architecture

### Three-layer bridge

```
External program → HTTP API → Node.js Host → Native Messaging / HTTP long-polling → Chrome Extension → target page
```

This shape comes from a Chrome MV3 constraint: a service worker cannot run an HTTP server directly. The Node.js process doubles as the HTTP server and the Native Messaging Host, avoiding the complexity of multi-process deployment. When Native Messaging is unavailable, the system automatically falls back to HTTP long-polling.

### Multi-step orchestration engine

A service is defined by a step graph; each step carries a script, a condition, success/failure transition targets, and a max-iteration budget:

- **Directed-graph execution:** `onSuccess` (success → next) / `onFailure` (failure / give-up → fallback) point at the next step id, or `TERMINATE` (stop).
- **Poll / retry:** a step with `maxIterations>1` returning `{ done:false }` reruns itself; on data or `{done:true}` it follows `onSuccess`; when the budget is exhausted or it returns `{failed:true}` it follows `onFailure` (the `SELF` sentinel is no longer used).
- **Dual iteration guard:** per-step `maxIterations` + global `maxStepIterations` (default 50) prevent runaway loops.
- **Cross-step data flow:** `__stepResults__` (history results indexed by step id) and `__lastResult__` (previous step's result, carrying state across a step's own retries).

### AI-driven script generation and repair

1. **Two-round HTML protocol:** round one sends a compact DOM summary (~8000 tokens) and the LLM returns candidate selectors; round two fetches only the full HTML of the candidate elements so the LLM can confirm or correct. This avoids truncation while keeping token usage efficient.
2. **Step-level auto-repair:** on failure, only the failing step's script is rewritten; the step-graph topology is preserved. Repair uses the current page's DOM snapshot + error context + prior step results.
3. **Element annotation assist:** when the LLM's selector confidence is below threshold, the visual element annotation mode kicks in automatically, turning user intent into structured annotations.

### Cross-iframe scraping

Every `$` API automatically traverses same-origin iframes. `querySelectorDeep` searches the main document and all same-origin iframe DOMs; `$list` aggregates matches across all documents. This is essential for sites that lean heavily on iframe nesting (e.g. government bulletin pages).

### Security sandbox

User scripts run inside a dedicated sandbox iframe (declared via the `sandbox` key in `manifest.json`) — the only context where `new Function()` / `eval()` is permitted under MV3. Scripts can only interact with the target page through the whitelisted API (`$`, `$click`, etc.); they cannot reach `chrome.*` APIs or the page's own JavaScript context.

### Key Chrome MV3 constraints

Chrome Manifest V3 imposes several hard constraints that directly shaped the design:

| Constraint | Impact | Mitigation |
|------------|--------|------------|
| Service worker cannot run an HTTP server | Extension can't expose an API directly | Add a Node.js Native Messaging Host as the HTTP bridge |
| `eval` / `new Function` forbidden in service worker and content script | Cannot execute user scripts directly | Create a sandbox iframe (declared in manifest) and run dynamic code there |
| Each extension can have only 1 offscreen document | Script execution surface is a singleton | Serialize execution through ExecutionQueue; multi-instance deployment sidesteps the limit |
| Service worker can be killed after ~30s idle | Long-poll loops may break | `chrome.alarms` heartbeat every 24s, auto-reconnect on disconnect |
| `chrome.storage.local` capped at 10MB | Large job data may overflow | 100-job cap + 24h TTL cleanup; future migration to IndexedDB |


## Copyright & License

This project is released under the [**GNU General Public License v3.0**](./LICENSE) (GPLv3).

### What you can and must do

- ✅ **Allowed:** free use, copy, modification, and distribution of this program, including commercial use
- ✅ **Allowed:** integrate this project into a larger system
- ⚠️ **Obligation:** any distribution or public deployment **must** include the complete corresponding source code
- ⚠️ **Obligation:** modified versions **must** be open-sourced under the same license (GPLv3), with clear marking of changes
- ⚠️ **Obligation:** preserve the original copyright and license notices

> In short: **you can use it free, sell it, and build on it — but the moment you distribute (including SaaS-style network deployment), you must open-source your derivative code under the same terms.**

The full legal text is in [`LICENSE`](./LICENSE). Official GPLv3 summary: <https://www.gnu.org/licenses/gpl-3.0.html>

### Developer

**Hunan Singhand Intelligent Data Technology Co.,Ltd**
Website: <https://www.singhand.com>

### Contributing

Bug reports and feature suggestions via Issues are welcome. Submitting a Pull Request means you agree to release your contribution under the GPLv3 license.

```text
Scrapewright
Copyright (C) 2026 Hunan Singhand Intelligent Data Technology Co.,Ltd

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU General Public License for more details.
```
