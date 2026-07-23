# <img src="logo.png" width="44" style="vertical-align:middle" alt="Scrapewright"> Scrapewright

**The open-source, self-hosted AI web scraper that turns natural language into HTTP API services.**

**English** | [简体中文](./README.zh-CN.md)

[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg)](./LICENSE)
![Node](https://img.shields.io/badge/Node.js-%3E%3D18-green)
![Chrome](https://img.shields.io/badge/Chrome-MV3-brightgreen)
![Platform](https://img.shields.io/badge/Platform-macOS%20%7C%20Linux%20%7C%20Windows-lightgrey)

> Developed and maintained by [Hunan Singhand Intelligent Data Technology Co.,Ltd](https://www.singhand.com) · Released under [**GPLv3**](./LICENSE)

Scrapewright is an **LLM-powered web scraping platform** and **AI web crawler** that converts plain-English descriptions of what you want to extract into reusable, HTTP-callable scraping services. Describe the target page and fields in natural language, and a large language model analyzes the site, generates the scraping script, runs it inside a real Chrome browser, and returns structured JSON — no CSS selectors to hand-write, no Playwright or Puppeteer code to maintain. The same step-graph engine also doubles as a lightweight **web test automation** / browser automation tool: click, type, wait, assert, branch — declarative, replayable, self-healing.

Because it runs as a **Chrome Extension (Manifest V3)** plus a lightweight **Node.js background service (HTTP)**, Scrapewright executes inside a genuine browser — its core advantage for hard targets. JavaScript-heavy SPAs, asynchronously loaded (XHR / fetch / streaming) content, deeply nested same-origin iframes, and complex multi-step interactions (pagination, detail-page drill-down, modal dismissal, login flows) all just work, with full DOM rendering and no `navigator.webdriver` footprint. Your logins, cookies, and fingerprint carry over as-is, so login-required and anti-bot-protected sites work out of the box. Every scraping service is exposed through a standard **REST / HTTP API** with JSON Schema I/O, so it drops cleanly into any backend, data pipeline, RPA flow, or AI agent stack.

**Great for:** login-required sites (intranets, paid content, SaaS dashboards), AI chatbot answer capture, paginated list + detail-page crawling, iframe-heavy government / portal pages, low-frequency high-value queries, knowledge-graph building, web test automation, and no-code data extraction for non-developers.

Design whitepaper: **[English](docs/technical-whitepaper.en.md)** · [中文](docs/technical-whitepaper.md)

> ### Quick start
>
> After loading the `extension/` folder at `chrome://extensions/` (Developer mode → Load unpacked):
>
> ```bash
> ./bin/scrapewright install     # install host as an OS background service (default port 8765)
> ```
>
> Then open the extension → **Options** → configure your LLM (OpenAI / Moonshot Kimi / Anthropic / GLM) → **+ New Service** → describe what you want to scrape in natural language → test → deploy → call it from anywhere:
>
> ```bash
> curl -X POST http://localhost:8765/api/v1/services/my-service/execute \
>   -H "X-API-Key: $SCRAPEWRIGHT_API_KEY" -H "Content-Type: application/json" \
>   -d '{"input": {"query": "hello"}}'
> ```

## Table of Contents

- [Background: Why Scrapewright](#background-why-scrapewright)
- [Core Features](#core-features)
- [System Requirements](#system-requirements)
- [Installation](#installation) · [Host Status](#host-status) · [Troubleshooting](#troubleshooting--faq)
- [HTTP API](#http-api) · [Script DSL](#script-dsl)
- [Comparison with Other Solutions](#comparison-with-other-solutions)
- [Distributed Deployment](#distributed-deployment) · [Technical Architecture](#technical-architecture)
- [Copyright & License](#copyright--license)

## Background: Why Scrapewright

Traditional web scraping tools and browser-automation frameworks — Scrapy, Puppeteer, Playwright, Selenium, BeautifulSoup, Cheerio — share several pain points that make web data extraction harder than it should be:

1. **High development cost** — every target site needs hand-written CSS selectors, pagination handling, and anti-bot countermeasures. Maintenance cost keeps accumulating as sites change.
2. **Painful dynamic pages** — SPA frameworks (React, Vue, Angular), nested iframes, and JavaScript-rendered content are hard to reach via plain HTTP requests or simple HTML parsers.
3. **Poor reusability** — scraping scripts are typically bespoke per site; they don't transfer to structurally similar pages, so the spider you wrote for site A won't help with site B.
4. **No unified interface** — different scraping jobs have no standardized input/output shape, which makes orchestration, scheduling, and scaling hard.

How Scrapewright answers each — this is what makes it a different kind of **AI web scraper**:

- **AI-driven** — describe *what* you want in natural language; the LLM analyzes page structure, generates the scraping script, and self-repairs on errors. Think "AI agent for the browser," but config-time instead of run-time.
- **Real browser environment** — runs as a Chrome extension inside a full browser, with first-class JavaScript rendering, iframe traversal, and dynamic loading. No headless-detected footprint.
- **Standardized API** — every scraping service is callable through a uniform HTTP API, with JSON Schema constraints on both input and output. The same shape every time, no matter how gnarly the target site.
- **Visual no-code wizard** — a 5-phase flow takes you from describing the requirement to a tested deployment, no code required. Non-technical users can ship a scraper.


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
| **Unified ops CLI** | `./bin/scrapewright` (install / start / stop / restart / status / doctor / logs) manages the host as an OS background service across Linux, macOS, and Windows |
| **Async execution queue** | Concurrent requests queue automatically and return asynchronously; well suited to batch scraping |

## System Requirements

- Chrome browser (latest stable)
- Node.js >= 18

## Installation

### 1. Load the Chrome Extension

1. Open Chrome and navigate to `chrome://extensions/`
2. Toggle on **Developer mode** in the top-right corner
3. Click **Load unpacked** and select the project's `extension/` directory
4. After it loads, note the **Extension ID** shown on the extension card (e.g. `dmbnejooocdfjmnebpglhedhfcgncgdl`) — for your own reference; the host install does not require it

### 2. Install the Host

The host runs as an OS background service so the extension can reach it over HTTP. It auto-starts at login, restarts on crash, and survives Chrome restarts and version updates.

**Linux / macOS:**

```bash
./bin/scrapewright install                    # default port 8765
./bin/scrapewright install --port=9123        # custom port
```

**Windows (PowerShell):**

```powershell
.\bin\scrapewright.cmd install                # default port 8765
.\bin\scrapewright.cmd install --port=9123
```

This registers a systemd user unit (Linux), a launchd LaunchAgent (macOS), or a scheduled task at logon (Windows). The port is baked into the service file at install time — re-running `install` with a new port rewrites the service file and restarts the host.

`scrapewright` command overview (full text at `./bin/scrapewright help`):

| Command | Purpose |
|---------|---------|
| `scrapewright install [--port=N]` | Install the host as an OS service and start it (first choice on a new machine) |
| `scrapewright status` | Show service state, `/health`, and port match |
| `scrapewright doctor` | Full diagnostic: service installed? running? `/health` reachable? port match? path drift? orphaned manifest? |
| `scrapewright start` / `stop` / `restart` | Service control (use `restart` after editing `host.js`) |
| `scrapewright run [--port=N]` | Run host in the foreground (for debugging / one-off runs) |
| `scrapewright logs [-f]` | Tail the host log in real time |
| `scrapewright uninstall` | Stop and remove the OS service |

> On Windows use `.\bin\scrapewright.cmd ...` (same commands).

After install, open the extension → **Options** → under **Server Configuration**, verify the port field matches what you installed with (default `8765`), then click **Test Connection**. The host status badge should read **Connected**.

> **Note:** If you later **move or rename the project directory**, the service file still points at the old absolute path. Re-run `./bin/scrapewright install` from the new location to rewrite it. `./bin/scrapewright doctor` detects this drift and prints the fix command.

### 3. Configure the LLM

1. Click the extension icon → the **Options** (service management) page opens
2. Click **Settings** (top-right) → under **LLM Configuration**, fill in:
   - **Provider** — pick an LLM provider (OpenAI / Moonshot / Kimi / Anthropic / GLM)
   - **Model** — model name (e.g. `gpt-4o`, `kimi-for-coding`, `glm-5.1`)
   - **API Key** — your API key
   - **Base URL** (optional) — custom API endpoint, useful for corporate proxies or OpenAI-compatible gateways. Must include the path prefix (e.g. `https://api.openai.com/v1`), not just the domain
3. Click **Save**

### 4. Create a Scraping Service

On the Options page click **+ New Service** to enter the AI wizard (5 phases):

| Phase | Description |
|-------|-------------|
| **Phase 1: Target URL & Requirements** | Enter the target site URL plus three requirement fields — input parameters, page operations & data to collect, and (optional) output structure. Click **Research** (or Ctrl+Enter); the AI analyzes the page and generates a draft service. Each field has an inline placeholder example. If the AI needs help, an interactive exploration/annotation panel appears inline. |
| **Phase 2: Service Name & Steps** | Name the service; review and **edit** the AI-generated step graph (each step is a script with success/failure transitions). |
| **Phase 3: I/O Schema & Test Input** | Confirm input/output parameter shapes (JSON Schema) and edit the test input data. |
| **Phase 4: Execute Test (step by step)** | Watch the live step-by-step execution log (open page → load → each step → success/failure). |
| **Phase 5: Results** | Review test results. On failure, choose **Auto-Fix** (AI self-repair) or **Deploy Anyway** (deploy despite the error). |

#### Auto-Fix loop dynamics

When **Auto-Fix** runs (either automatically after a test failure or manually with a user hint), the loop now behaves as follows:

- **Best-of-N retention** — every iteration is scored against the output schema (required-field coverage × list density × per-item field fill). If a later iteration regresses, the wizard silently restores the highest-scoring script instead of committing the degraded one. No user action required.
- **User-feedback ACK protocol** — when you provide a hint, it appears as Section 1 of the LLM prompt with an explicit ACK/NACK requirement. The model must output `// ACK: <paraphrased hint>` or `// NACK: <reason>` before writing code. If the model NACKs the same hint twice, the prompt escalates with a "you may be wrong" note.
- **Intervention banners** — instead of silently exhausting retries, the wizard surfaces specific "I need human help" conditions as a banner above the results:
  - **Needs annotation** — extraction returns empty and the failing step has no annotations. Action: *Go to annotation*.
  - **Needs annotation relax** — annotations exist but their selectors match nothing on the live page (often caused by positional `:nth-of-type` paths that don't generalize). Action: *Go to annotation*.
  - **Needs login** — the page redirected to a login flow. Action: *Open target tab*.
  - **Rate limited** — the LLM provider returned 429. Action: *Open settings*.
  - **Page state stale** — the same error has persisted across multiple attempts and the captured snapshot is over 60 seconds old. Action: *Refresh tab*.

  Each banner has an **Ignore and continue** button to dismiss the intervention and let autoFix keep trying.

### 5. Manage Services

In the **Services** section of the Options page:

- **Enable / Disable** — toggle a service on or off
- **Edit** — return to the wizard to edit (pre-filled with the existing config)
- **Export** — export a single service as JSON
- **Export All** — export every service
- **Import** — import services from JSON (duplicates are skipped automatically)
- **Delete** — delete a service

The bottom of the Options page shows **Execution History** (the most recent 20 runs) with timestamp, service name, and success/failure status.

## Host Status

There is one transport between the host and the extension: **HTTP long-polling**. The extension pulls requests via `GET /api/v1/extension/poll` and replies via `POST /api/v1/extension/response`. The host is brought up by the OS service supervisor (installed in step 2) — no manual start needed.

The extension's options page shows one of two states:

- **Connected** — host reachable at the configured port.
- **Disconnected** — host not running, or the port doesn't match.

If disconnected, check in order:

1. `./bin/scrapewright status` — is the service installed and running?
2. The port in the extension's options page under **Server Configuration** matches what `scrapewright install --port=N` was given (default `8765`).
3. `./bin/scrapewright doctor` — full diagnostics.

You can also run the host in the foreground for debugging:

```bash
./bin/scrapewright run                       # default port 8765
./bin/scrapewright run --port=19880          # custom port
```

> **Note:** In foreground mode, make sure the port on the extension's options page matches the `--port` argument.

## Troubleshooting / FAQ

### Service won't start

Run `./bin/scrapewright doctor`. Common causes:

- **Node not found** — the service file pins an absolute path to `node`; if you upgraded Node or moved it, re-run `./bin/scrapewright install` to rewrite the path.
- **Port already in use** — pick another with `./bin/scrapewright install --port=N` (and update the port in the extension's options page to match).
- **Project moved** — the service file points at the old absolute path; re-run `./bin/scrapewright install` from the new directory. Doctor detects this drift and prints the fix command.
- **Orphaned Native Messaging artifacts from a previous install** — doctor detects and removes leftover manifests automatically, with a one-line notice.

### Port mismatch

If the host is listening on `:9123` but the extension is polling `:8765`, the options page shows **Disconnected**. Update the port field under **Server Configuration** to match what you installed with, then click **Test Connection**.

### Tail the host log

```bash
./bin/scrapewright logs -f                       # all platforms (CLI)
tail -f ~/Library/Logs/scrapewright/host.log      # macOS
tail -f ~/.cache/scrapewright/host.log            # Linux
Get-Content -Wait "$env:LOCALAPPDATA\scrapewright\host.log" -Tail 20   # Windows
```

Boot crashes (before the logger initializes) land in `startup-error.log` next to `host.log` — that's the real stack trace behind an opaque startup failure.

### Picking up code changes

After editing `host.js`, run `./bin/scrapewright restart` to bring up the new code. After editing extension files, reload the extension at `chrome://extensions/` (click the refresh icon on the extension card).

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

Only queued jobs (`status: "queued"`) can be cancelled. In-flight jobs cannot be cancelled.

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
| `extensionConnected` | Whether the extension is currently connected to the host via HTTP long-polling |
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

Scrapewright is built on four pillars: a **three-layer bridge** (external program → Node.js HTTP Host → Chrome Extension → target page) that works around MV3's ban on HTTP servers in the service worker; a **step-graph orchestration engine** (`StepOrchestrator`) that runs a directed graph of named steps with conditional edges, polling/retry budgets, and cross-step data flow; **sandboxed script execution** via a single offscreen-hosted iframe where `eval`/`new Function` is permitted under MV3 CSP; and a **single HTTP-based transport** (long-polling both ways) between the Host and the extension, with the Host running as a per-OS background service. AI-driven script generation, step-level auto-repair, and visual element annotation sit on top of these pillars.

See the [Technical Whitepaper](docs/technical-whitepaper.en.md) for the full architecture, data flow, module reference, file-tree layout, Chrome MV3 constraint table, and development/contributing guide.


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
