# Chrome Web Store — Listing Copy (Scrapewright 0.1)

Paste-ready copy for the CWS Developer Dashboard. Character limits verified against CWS rules.

## Category

**Developer Tools** (fallback: Productivity)

## Name

Scrapewright

## Short description (≤132 characters)

> Describe scraping tasks in plain language; AI builds and deploys them as local HTTP services in your own browser.

(113 characters)

## Detailed description

```
Scrapewright turns "what you want from a website" into a reusable HTTP service — built by AI, running inside your own logged-in browser.

You describe the task in natural language ("search this site for my query, open each result, return title, author, date, price"). The AI wizard opens the page, analyzes its structure, writes the extraction steps, and test-runs them in front of you. Once verified, the task is deployed as a local HTTP endpoint any script, scheduler, or AI agent can call.

WHY RUN IT IN YOUR OWN BROWSER
• Login state reused as-is — scrape intranets, SaaS dashboards, and paid archives you're already signed into. No cookie configuration, no scripted logins.
• Full page fidelity — JS-rendered content, nested iframes, pagination, hover popups, lazy-loaded feeds, and per-item detail pages are all extractable.
• No automation fingerprint — requests come from a genuine browser, not a headless instance.

ZERO AI COST AT RUN TIME
The LLM is used only when you create or repair a service. Deployed services run as deterministic step graphs with no AI calls — fast, cheap, and re-runnable as often as you like. When a site redesigns and breaks a scraper, Auto-Fix reads the new page layout and repairs the script.

A UNIFORM HTTP API
Every service exposes JSON-in / JSON-out with declared schemas:
  POST /api/v1/services/{name}/execute  → returns a jobId
  GET  /api/v1/jobs/{jobId}/wait       → blocks until done
Results include every visited page (URL, title, cleaned HTML), and each extracted record is stamped with the id of the page it came from — provenance built in. Each service can also export a Markdown API doc for other tools and AI agents to consume.

SELF-HEALING SCRAPES
Failures are classified (element not found, timeout, login required) and the AI can attempt automatic repair using the error and a sanitized DOM snapshot. Repair beats rewrite.

PRIVACY
• No accounts, no telemetry, no analytics.
• At run time, nothing leaves your machine — deployed services make zero external AI calls.
• During service creation/repair, cleaned page structure goes only to the LLM provider YOU configure (OpenAI, Anthropic, Moonshot Kimi, GLM, or any OpenAI-compatible endpoint), under that provider's policy.
• Scraped data and logs stay on your machine, served only to localhost callers behind your API key.
Full policy: https://github.com/singhand-labs/scrapewright/blob/main/docs/privacy-policy.md

REQUIREMENTS
• Chrome (latest stable) and Node.js ≥ 18 for the companion local service (one-command install: ./bin/scrapewright install; the extension shows connection status and diagnostics).
• An API key for any supported LLM provider (needed only while building/repairing services).

OPEN SOURCE
GPLv3. Source, examples, and a full technical whitepaper: https://github.com/singhand-labs/scrapewright

HONEST SCOPE
Scrapewright is built for repeated, targeted extraction from pages you can access — not for high-volume anonymous crawling (use server-side tools for that) or 24/7 unattended farms. Use it responsibly and in accordance with the terms of service of the sites you access.
```

## Screenshot plan (1280×800, up to 5)

1. Options page — services list + Host Status card ("Connected"): shows the product's home surface.
2. Wizard Phase 1 — natural-language requirement + Research in progress: the core "describe it" moment.
3. Wizard Phase 4/5 — live step-by-step test run with extracted data table: the payoff.
4. Auto-Fix in action — error + user feedback box + repaired result: the self-healing story.
5. Terminal — the two curl calls (execute → wait) with JSON result: the "it's an API" story.

Optional promo tile (440×280): logo + tagline "Describe it. Deploy it. Call it." over a subtle page-structure motif.

## Icons

Use `extension/icons/icon128.png` (already 128×128) as the store icon.
