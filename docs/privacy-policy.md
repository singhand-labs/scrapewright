# Scrapewright Privacy Policy

Last updated: 2026-08-21

Scrapewright is an open-source (GPLv3) Chrome extension that turns web scraping tasks you describe into reusable services running inside your own browser. This policy explains what the extension does — and does not do — with data. Because the project is open source, every claim below is verifiable in the source code: <https://github.com/singhand-labs/scrapewright>

## Summary

- **No accounts, no telemetry, no analytics, no ads.** The extension contains no tracking of any kind and communicates only with components you configure.
- **At run time, nothing leaves your machine.** Executing a deployed scraping service makes no external network calls to any AI or vendor service.
- **During service creation and auto-repair, cleaned page structure is sent to the AI (LLM) provider you configure**, under that provider's own privacy policy.
- **Scraped data and logs stay on your machine**, stored in extension-local storage and local log files, and are served only to programs you run via a localhost HTTP API protected by an API key.

## What the extension processes

- **Page content of sites you configure it for.** When you create or repair a scraping service, the extension reads the DOM of pages you open for that purpose, cleans/sanitizes it, and uses it to generate or repair extraction logic.
- **Your descriptions of scraping tasks** (the natural-language requirements you type into the wizard).
- **Execution data**: structured results, visited-page snapshots (URL, title, cleaned HTML), and success/failure details of runs you initiate.

## Where data goes

**To an LLM provider you choose (configuration and repair time only).**
When the AI wizard researches a page, drafts scraping steps, or auto-repairs a failing step, Scrapewright sends the relevant cleaned page structure, element HTML, step scripts, and error information to the LLM endpoint **you configured** (e.g. OpenAI, Anthropic, Moonshot Kimi, GLM, or any custom OpenAI-compatible endpoint). That transmission is governed by the privacy policy of the provider you chose. Scrapewright itself operates no backend and never receives this data.

**Nowhere else, at run time.**
Deployed services execute deterministically in your browser with **zero LLM calls and zero external AI requests**. The extension does not send page content, results, or usage information to any server operated by the Scrapewright project — no such server exists.

**To programs you run, via localhost.**
A companion local service (which you install separately) exposes an HTTP API on `localhost` so your own scripts, schedulers, or agents can request scrapes. It binds locally and requires an API key you control. Scraped results are delivered only to callers of that local API.

## What is stored, and where

- **Service definitions** (step graphs, schemas) and **execution history** (recent runs, capped) — in the extension's local (`chrome.storage.local`) storage, on your machine only.
- **Host logs** — structured log files on your local disk (location documented in the README), written by the local companion service.
- **No cloud storage.** There is no Scrapewright account system or remote database.

## What we do not do

- We do not collect, transmit, or sell browsing history, personal data, or scraped content.
- We do not use your data for advertising or product analytics.
- We do not require or store credentials for any website. Scrapewright simply runs in your existing browser session; it never reads, exports, or transmits your passwords or cookies.

## Your control

Uninstalling the extension removes its local storage. Deleting a service, clearing execution history, or uninstalling the companion host removes the corresponding local data. You choose which pages to scrape, which LLM provider to use (if any), and can review all generated scraping logic before deploying it.

## Third-party sites

Scrapewright reads pages you direct it to. You are responsible for using it in accordance with the terms of service of the sites you access and applicable law.

## Changes to this policy

Material changes will be published in this file in the project repository, with an updated "Last updated" date.

## Contact

Open an issue at <https://github.com/singhand-labs/scrapewright/issues> for any privacy-related question or report.
