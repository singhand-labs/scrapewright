// Drift guard for createInlineEnhancedModeCache in content-script.js.
//
// Mirrors the pattern of test/inline-list-extract-ops-drift.test.js and
// test/inline-scroll-ops-drift.test.js: content-script.js has a defensive
// INLINE copy of the cache factory (because content scripts can't load
// renderer-activation.js — chrome.debugger territory), and the inline copy
// must stay behaviorally identical to the canonical implementation.
//
// This test enforces that parity by extracting both factories from source
// and asserting they produce the same observable behavior on the same inputs.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const CONTENT_SCRIPT_PATH = path.join(__dirname, '..', 'content-script.js');
const RENDERER_ACTIVATION_PATH = path.join(__dirname, '..', 'lib', 'renderer-activation.js');

// Extract the inline factory from content-script.js by evaluating its source
// in a minimal sandbox. The factory is defined as a function declaration at
// the top level of the IIFE — we capture it by injecting `global.__inlineCache = null`
// and a hook at the end of the factory that assigns it.
function loadInlineFactory() {
  const src = fs.readFileSync(CONTENT_SCRIPT_PATH, 'utf8');
  // Slice from the createInlineEnhancedModeCache declaration to its matching
  // closing brace. The function ends with `};\n  }` (return-statement object
  // then function close). Find the start and walk braces.
  const startMatch = src.match(/function createInlineEnhancedModeCache\(opts\) \{/);
  if (!startMatch) throw new Error('createInlineEnhancedModeCache not found in content-script.js');
  const startIdx = startMatch.index;
  let depth = 0;
  let endIdx = -1;
  let inString = false;
  let stringChar = null;
  for (let i = startIdx + startMatch[0].length - 1; i < src.length; i++) {
    const c = src[i];
    if (inString) {
      if (c === '\\') { i++; continue; }
      if (c === stringChar) inString = false;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { inString = true; stringChar = c; continue; }
    if (c === '/' && src[i + 1] === '/') {
      // line comment — skip to end of line
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i++;
      continue;
    }
    if (c === '{') depth++;
    if (c === '}') {
      depth--;
      if (depth === 0) { endIdx = i; break; }
    }
  }
  if (endIdx < 0) throw new Error('could not find end of createInlineEnhancedModeCache');
  const factorySrc = src.slice(startIdx, endIdx + 1);
  // Build a sandbox that exposes the factory as a global.
  const sandbox = { chrome: {}, location: { href: 'test://' }, console };
  const wrappedSrc = factorySrc + '\n;this.__factory = createInlineEnhancedModeCache;';
  const factory = (function () {
    // eslint-disable-next-line no-new-func
    const fn = new Function('with (this) { ' + wrappedSrc + ' }');
    fn.call(sandbox);
    return sandbox.__factory;
  })();
  if (typeof factory !== 'function') {
    throw new Error('inline factory did not bind to sandbox.__factory');
  }
  return factory;
}

describe('inline createEnhancedModeCache drift guard (content-script.js vs lib/renderer-activation.js)', () => {
  it('extracts both factories without syntax error', () => {
    const inlineFactory = loadInlineFactory();
    assert.equal(typeof inlineFactory, 'function');
    const { createEnhancedModeCache } = require('../lib/renderer-activation');
    assert.equal(typeof createEnhancedModeCache, 'function');
  });

  it('both factories produce identical observable behavior on cached state transitions', async () => {
    const inlineFactory = loadInlineFactory();
    const { createEnhancedModeCache } = require('../lib/renderer-activation');
    let calls = 0;
    let current = true;
    const mkQuery = () => () => {
      calls++;
      return Promise.resolve(current);
    };
    const inline = inlineFactory({ query: mkQuery() });
    const canonical = createEnhancedModeCache({ query: mkQuery() });

    // Both start unknown
    assert.equal(inline.isKnown(), canonical.isKnown());

    // First getState: both query, both cache true
    const a1 = await inline.getState();
    const c1 = await canonical.getState();
    assert.equal(a1, c1, 'both should return true on first getState');
    assert.equal(inline.isKnown(), canonical.isKnown());

    // Second getState: both return cached, no new query
    calls = 0;
    const a2 = await inline.getState();
    const c2 = await canonical.getState();
    assert.equal(a2, c2);
    assert.equal(calls, 0, 'neither should query on cached getState');

    // Invalidate: both flip back to unknown
    inline.invalidate();
    canonical.invalidate();
    assert.equal(inline.isKnown(), canonical.isKnown());

    // Re-query after invalidate: both pick up new state
    current = false;
    calls = 0;
    const a3 = await inline.getState();
    const c3 = await canonical.getState();
    assert.equal(a3, c3, 'both should return false after toggle+invalidate');
    assert.equal(a3, false);
    assert.ok(calls >= 2, 'both should have re-queried');
  });

  it('both factories handle concurrent getState() without duplicate queries', async () => {
    const inlineFactory = loadInlineFactory();
    const { createEnhancedModeCache } = require('../lib/renderer-activation');
    let calls = 0;
    const mkQuery = () => () => {
      calls++;
      return new Promise(r => setTimeout(() => r(true), 10));
    };
    const inline = inlineFactory({ query: mkQuery() });
    const canonical = createEnhancedModeCache({ query: mkQuery() });

    calls = 0;
    await Promise.all([inline.getState(), inline.getState(), inline.getState()]);
    const inlineCalls = calls;
    assert.equal(inlineCalls, 1, 'inline: 3 concurrent gets → 1 query');

    calls = 0;
    await Promise.all([canonical.getState(), canonical.getState(), canonical.getState()]);
    const canonicalCalls = calls;
    assert.equal(canonicalCalls, 1, 'canonical: 3 concurrent gets → 1 query');
  });

  it('both factories default to false when no query provided', async () => {
    const inlineFactory = loadInlineFactory();
    const { createEnhancedModeCache } = require('../lib/renderer-activation');
    const inline = inlineFactory({});
    const canonical = createEnhancedModeCache({});
    assert.equal(await inline.getState(), false);
    assert.equal(await canonical.getState(), false);
  });
});
