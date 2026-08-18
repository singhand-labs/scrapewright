// Drift guard: RC20 (console.log 2026-07-30) introduces a tab-activation
// layer that briefly activates the scrape tab during input-required DOM ops.
// Content scripts can't call chrome.tabs.* directly, so the integration is
// split across three files:
//
//   1. extension/lib/tab-activation.js — request/release/with helpers
//   2. extension/background.js — TAB_ACTIVATION_REQUEST / TAB_ACTIVATION_RELEASE
//      handlers that call the lib
//   3. extension/content-script.js — withTabActivation(fn) helper that uses
//      chrome.runtime.sendMessage to invoke the background handlers; wraps
//      domScrollToBottom's body
//
// If any of these pieces drift (e.g. someone refactors and forgets to wrap a
// new scroll entry point, or the message-type strings get renamed on one
// side but not the other), the scrape silently reverts to the RC12-RC19
// "BG tab stuck at 4 posts" symptom. Source-text audit (no execution)
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

  it('background.js wires both TAB_ACTIVATION_REQUEST and TAB_ACTIVATION_RELEASE handlers', () => {
    const src = fs.readFileSync(BG_PATH, 'utf8');
    // Message-type strings must appear as the dispatch keys, not just in
    // comments. Match the dispatch pattern "message.type === '...'".
    assert.ok(/message\.type\s*===\s*['"]TAB_ACTIVATION_REQUEST['"]/.test(src),
      "background.js must dispatch on message.type === 'TAB_ACTIVATION_REQUEST'");
    assert.ok(/message\.type\s*===\s*['"]TAB_ACTIVATION_RELEASE['"]/.test(src),
      "background.js must dispatch on message.type === 'TAB_ACTIVATION_RELEASE'");
    // Both handlers must call the TabActivation API (not just define stubs).
    assert.ok(/TabActivation\.requestActivation\(/.test(src),
      'TAB_ACTIVATION_REQUEST handler must call TabActivation.requestActivation');
    assert.ok(/TabActivation\.releaseActivation\(/.test(src),
      'TAB_ACTIVATION_RELEASE handler must call TabActivation.releaseActivation');
  });

  it('content-script.js defines withTabActivation helper', () => {
    const src = fs.readFileSync(CS_PATH, 'utf8');
    assert.ok(/(?:async\s+)?function\s+withTabActivation\s*\(/.test(src),
      'content-script.js must define withTabActivation');
  });

  it('content-script.js withTabActivation sends both message types', () => {
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
    assert.ok(/type:\s*['"]TAB_ACTIVATION_RELEASE['"]/.test(body),
      "withTabActivation must send {type: 'TAB_ACTIVATION_RELEASE'}");
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
});
