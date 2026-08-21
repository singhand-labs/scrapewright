# Chrome Web Store — Review Notes (Scrapewright 0.1)

Paste-ready text for the CWS "Review notes" field, addressing the four points most likely to draw scrutiny. Keep the video link at the end (record before submitting; a 2–3 minute screen recording is usually enough).

---

Scrapewright is an open-source (GPLv3) web-scraping platform. Users describe a scraping task in natural language; an AI wizard analyzes the target page, generates the extraction logic, test-runs it, and deploys it as a local HTTP service. Full source: https://github.com/singhand-labs/scrapewright

## Architecture (what talks to what)

Two user-installed components, both local:

1. This extension — runs the scraping in the user's own browser.
2. A companion Node.js service the user installs separately from the repository (`./bin/scrapewright install`). It listens on localhost (default port 8765) and exposes an HTTP API so the user's own scripts can trigger scrapes. The extension contacts it over plain HTTP to localhost — there is NO native messaging, and the extension works entirely on the user's machine. No Scrapewright-operated backend exists; the only external requests the extension ever makes are to the AI (LLM) endpoint the user themselves configures.

## Permission justifications

- `debugger` — used exclusively to dispatch trusted wheel (scroll) input via CDP `Input.dispatchMouseEvent` on background/throttled tabs whose lazy-loading content ignores programmatic scrolling (`isTrusted: false`). We attach transiently, issue ONLY `Input.*` commands (no `Runtime.*`, `Network.*`, or `DOM.*`), cap the number of attempts, and detach immediately. Chrome's standard "extension is debugging this browser" infobar is visible to the user whenever attached. Source: `extension/lib/renderer-activation.js`, `extension/lib/scroll-ops.js`.
- `<all_urls>` host permission + content scripts on all pages — scraping targets are chosen by the user at runtime (any site they configure); domains cannot be pre-declared. Content scripts perform DOM operations (read/extract/click/scroll) only on pages involved in user-configured scrape jobs.
- `scripting` — injects step-logic execution and page checks into scrape tabs.
- `tabs` / `windows` — lifecycle management of the background tab each scrape runs in, and restoring the user's previously focused tab afterward.
- `offscreen` — hosts the sandboxed execution surface (see below).
- `storage` / `unlimitedStorage` — service definitions and recent execution history, stored locally (`chrome.storage.local`).
- `activeTab`, `alarms` — user-initiated page operations; connection retry scheduling.

## Sandboxed execution of AI-generated code

Generated scraping snippets execute ONLY inside a manifest-declared sandbox page (`sandbox.html`, listed under `"sandbox"`). This is Chrome's sanctioned pattern for untrusted code: the page is loaded in a sandboxed iframe with a unique opaque origin, has **zero access to `chrome.*` APIs**, the extension's storage, or any origin's data. All privileged operations (tab access, DOM operations in target pages) are performed by static extension code that the sandbox reaches only via explicit message passing — the generated code cannot escalate. No generated code is ever injected into web pages. This mirrors the architecture of user-script managers. The LLM endpoint is user-configured; the extension bundles no remote logic of its own.

## Data handling

- Run time: deployed services make NO external network calls (no AI, no telemetry, no analytics).
- Configuration/repair time: cleaned page structure and error details are sent only to the user-configured LLM provider, under that provider's policy.
- Scraped results and logs remain on the user's machine; the local API is localhost-bound and API-key protected.
- Privacy policy: https://github.com/singhand-labs/scrapewright/blob/main/docs/privacy-policy.md

## How to test

Without the companion service: load the extension, open the options page — the Host Status card will show "Disconnected" by design, and all UI is navigable.

Full functionality (2–3 minutes): install the companion service from the repo (`./bin/scrapewright install`), confirm "Connected" on the options page, click "+ New Service", enter any public URL + a simple requirement, and run Research — the wizard opens the page, drafts steps, and test-runs them live.

Demo video: <RECORD AND PASTE LINK — suggested: wizard run on a public site, then the two curl calls>

Contact: GitHub issues at https://github.com/singhand-labs/scrapewright/issues
