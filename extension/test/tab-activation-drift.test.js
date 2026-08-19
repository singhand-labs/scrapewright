// Drift guard: RC20 introduced a tab-activation layer that activates the
// scrape tab during input-required DOM ops; RC56 (sticky activation) removed
// the release/restore half. Content scripts can't call chrome.tabs.* directly,
// so the integration is split across three files:
//
//   1. extension/lib/tab-activation.js — requestActivation +
//      initTabActivationListeners (chrome.tabs.onActivated/onRemoved:
//      user-switch tracking + landing focus when a scrape tab closes)
//   2. extension/background.js — TAB_ACTIVATION_REQUEST handler + a top-level
//      TabActivation.initTabActivationListeners() call (must run at SW startup
//      so listeners re-register on every MV3 wake)
//   3. extension/content-script.js — withTabActivation(label, fn) helper that
//      sends ONLY TAB_ACTIVATION_REQUEST via chrome.runtime.sendMessage
//      (sticky: activation persists, no release message); wraps the
//      scrollToBottom / hover / hoverDismiss call sites
//
// If any of these pieces drift (e.g. someone refactors and forgets to wrap a
// new entry point, or the message-type strings get renamed on one side but
// not the other), the scrape silently reverts to the RC12-RC19
// "BG tab stuck at 4 items" symptom. Source-text audit (no execution)
// because content-script.js is an IIFE that doesn't export anything.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const LIB_PATH = path.join(__dirname, '..', 'lib', 'tab-activation.js');
const BG_PATH = path.join(__dirname, '..', 'background.js');
const CS_PATH = path.join(__dirname, '..', 'content-script.js');

describe('RC20 tab-activation integration drift guard', () => {
  it('lib/tab-activation.js exists and is IIFE-wrapped', () => {
    const src = fs.readFileSync(LIB_PATH, 'utf8');
    // IIFE-wrap precedent: scrape-tab.js RC13 var-after-const SyntaxError.
    assert.ok(/\(function\s*\(\s*global\s*\)\s*\{/.test(src),
      'tab-activation.js must be IIFE-wrapped to avoid lexical collisions');
    assert.ok(/requestActivation/.test(src), 'requestActivation not found');
    // RC56: sticky activation removed releaseActivation from the lib; the
    // background RELEASE handler remains until Task 2 removes it.
  });

  it('background.js imports lib/tab-activation.js via importScripts', () => {
    const src = fs.readFileSync(BG_PATH, 'utf8');
    assert.ok(/['"]lib\/tab-activation\.js['"]/.test(src),
      "background.js importScripts block must include 'lib/tab-activation.js'");
  });

  it('lib/tab-activation.js registers onActivated/onRemoved listeners', () => {
    const src = fs.readFileSync(LIB_PATH, 'utf8');
    assert.ok(/chrome\.tabs\.onActivated\.addListener/.test(src),
      'lib/tab-activation.js must register chrome.tabs.onActivated listener');
    assert.ok(/chrome\.tabs\.onRemoved\.addListener/.test(src),
      'lib/tab-activation.js must register chrome.tabs.onRemoved listener');
    assert.ok(/initTabActivationListeners/.test(src),
      'lib/tab-activation.js must define initTabActivationListeners');
  });

  it('background.js wires the TAB_ACTIVATION_REQUEST handler + listener init', () => {
    const src = fs.readFileSync(BG_PATH, 'utf8');
    // Message-type strings must appear as the dispatch keys, not just in
    // comments. Match the dispatch pattern "message.type === '...'".
    assert.ok(/message\.type\s*===\s*['"]TAB_ACTIVATION_REQUEST['"]/.test(src),
      "background.js must dispatch on message.type === 'TAB_ACTIVATION_REQUEST'");
    // The handler must call the TabActivation API (not just define a stub).
    assert.ok(/TabActivation\.requestActivation\(/.test(src),
      'TAB_ACTIVATION_REQUEST handler must call TabActivation.requestActivation');
    // RC56: listeners must register at top level (SW startup), not lazily.
    // Pin the guarded block itself — a bare /TabActivation\.initTabActivationListeners\(\)/
    // would also match a call lazily nested inside some function.
    const guarded =
      /typeof TabActivation !== 'undefined'[\s\S]{0,120}?TabActivation\.initTabActivationListeners\(\)/;
    assert.ok(guarded.test(src),
      'background.js must contain the guarded top-level TabActivation.initTabActivationListeners() block');
    // Heuristic: top-level init runs before the first message listener is
    // registered (if listener registration ever moves above it, that's fine —
    // the guarded-block assert above is the real invariant).
    const initIdx = src.search(guarded);
    const listenerIdx = src.indexOf('chrome.runtime.onMessage.addListener');
    assert.ok(initIdx !== -1 && (listenerIdx === -1 || initIdx < listenerIdx),
      'initTabActivationListeners block must appear before the first chrome.runtime.onMessage.addListener');
  });

  it('RC56: TAB_ACTIVATION_RELEASE channel is fully removed', () => {
    for (const p of [BG_PATH, CS_PATH, LIB_PATH]) {
      const src = fs.readFileSync(p, 'utf8');
      assert.ok(!src.includes('TAB_ACTIVATION_RELEASE'),
        `${path.basename(p)} must not reference TAB_ACTIVATION_RELEASE`);
    }
  });

  it('content-script.js defines withTabActivation helper', () => {
    const src = fs.readFileSync(CS_PATH, 'utf8');
    assert.ok(/(?:async\s+)?function\s+withTabActivation\s*\(/.test(src),
      'content-script.js must define withTabActivation');
  });

  it('content-script.js withTabActivation sends only TAB_ACTIVATION_REQUEST', () => {
    const src = fs.readFileSync(CS_PATH, 'utf8');
    // Slice the withTabActivation body so we don't match unrelated mentions.
    const start = src.indexOf('function withTabActivation');
    assert.ok(start !== -1, 'withTabActivation not found');
    // Find the closing brace of the function.
    let depth = 0;
    let inString = null;
    let bodyStart = -1;
    let bodyEnd = -1;
    for (let i = start; i < src.length; i++) {
      const ch = src[i];
      if (inString) {
        if (ch === '\\') { i++; continue; }
        if (ch === inString) inString = null;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === '`') { inString = ch; continue; }
      if (ch === '{') {
        if (bodyStart === -1) bodyStart = i;
        depth++;
      } else if (ch === '}') {
        depth--;
        if (depth === 0) { bodyEnd = i; break; }
      }
    }
    assert.ok(bodyStart !== -1 && bodyEnd !== -1, 'could not slice withTabActivation body');
    const body = src.slice(start, bodyEnd + 1);
    assert.ok(/type:\s*['"]TAB_ACTIVATION_REQUEST['"]/.test(body),
      "withTabActivation must send {type: 'TAB_ACTIVATION_REQUEST'}");
  });

  it('content-script.js wraps scrollToBottom / hover / hoverDismiss call sites', () => {
    const src = fs.readFileSync(CS_PATH, 'utf8');
    assert.ok(/withTabActivation\(\s*['"]scrollToBottom['"]/.test(src),
      "scrollToBottom must be wrapped via withTabActivation('scrollToBottom', ...)");
    assert.ok(/withTabActivation\(\s*['"]hover['"]/.test(src),
      "hover must be wrapped via withTabActivation('hover', ...)");
    assert.ok(/withTabActivation\(\s*['"]hoverDismiss['"]/.test(src),
      "hoverDismiss must be wrapped via withTabActivation('hoverDismiss', ...)");
  });

  it('content-script.js wraps domScrollToBottom body via withTabActivation', () => {
    const src = fs.readFileSync(CS_PATH, 'utf8');
    // Slice domScrollToBottom's body. Same brace walker as above.
    const start = src.indexOf('function domScrollToBottom');
    assert.ok(start !== -1, 'domScrollToBottom not found');
    let depth = 0;
    let inString = null;
    let bodyStart = -1;
    let bodyEnd = -1;
    for (let i = start; i < src.length; i++) {
      const ch = src[i];
      if (inString) {
        if (ch === '\\') { i++; continue; }
        if (ch === inString) inString = null;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === '`') { inString = ch; continue; }
      if (ch === '{') {
        if (bodyStart === -1) bodyStart = i;
        depth++;
      } else if (ch === '}') {
        depth--;
        if (depth === 0) { bodyEnd = i; break; }
      }
    }
    assert.ok(bodyStart !== -1 && bodyEnd !== -1, 'could not slice domScrollToBottom body');
    const body = src.slice(start, bodyEnd + 1);
    assert.ok(/withTabActivation\s*\(/.test(body),
      'domScrollToBottom must wrap its scroll work via withTabActivation');
    assert.ok(/return await withTabActivation/.test(body) ||
              /return withTabActivation/.test(body),
      'domScrollToBottom must return the withTabActivation result');
  });

  it('RC64: handleOpenTabExecute activates the sub-tab before load/execution', () => {
    const src = fs.readFileSync(BG_PATH, 'utf8');
    // Slice handleOpenTabExecute's body. Same brace walker as above.
    const start = src.indexOf('async function handleOpenTabExecute');
    assert.ok(start !== -1, 'handleOpenTabExecute not found');
    let depth = 0;
    let inString = null;
    let bodyStart = -1;
    let bodyEnd = -1;
    for (let i = start; i < src.length; i++) {
      const ch = src[i];
      if (inString) {
        if (ch === '\\') { i++; continue; }
        if (ch === inString) inString = null;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === '`') { inString = ch; continue; }
      if (ch === '{') {
        if (bodyStart === -1) bodyStart = i;
        depth++;
      } else if (ch === '}') {
        depth--;
        if (depth === 0) { bodyEnd = i; break; }
      }
    }
    assert.ok(bodyStart !== -1 && bodyEnd !== -1, 'could not slice handleOpenTabExecute body');
    const body = src.slice(start, bodyEnd + 1);
    // The guarded activation call must exist inside the function.
    const actIdx = body.search(/TabActivation\.requestActivation\(\s*tab\.id\s*\)/);
    assert.ok(actIdx !== -1,
      'handleOpenTabExecute must call TabActivation.requestActivation(tab.id) — sub-tabs rendering JS-heavy detail pages never produce compositor frames as background tabs (RC20/RC56 mechanism), leaving content extracts deterministically empty');
    // It must run BEFORE the tab starts loading and before the script executes,
    // so the page renders with compositor frames from initial load onward.
    const loadIdx = body.indexOf('waitForTabLoad');
    assert.ok(loadIdx !== -1, 'handleOpenTabExecute must call waitForTabLoad');
    assert.ok(actIdx < loadIdx,
      'activation must precede waitForTabLoad so the sub-tab is active during initial render');
    const execIdx = body.search(/executor\.execute/);
    assert.ok(execIdx !== -1, 'handleOpenTabExecute must call executor.execute');
    assert.ok(actIdx < execIdx,
      'activation must precede executor.execute');
  });
});
