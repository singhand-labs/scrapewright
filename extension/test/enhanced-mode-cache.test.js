// Regression for console.log 2026-08-04 trusted-wheel silent failure.
//
// SYMPTOM: every scroll stall on a lazy-load page in Enhanced-Mode-off runs
// produced THREE full message round-trips per $scrollToBottom:
//   stall → trustedWheel_request → trustedWheel_response{reason:"debugger
//   permission not granted"} → next stall → same → next stall → same.
//
// Across the FB scrape run (lines 511-560, 657-725), this pattern appeared
// dozens of times. Each round-trip is a chrome.runtime.sendMessage +
// chrome.storage.local.get + response message — pure waste, because the
// state ("Enhanced Mode is off") doesn't change during a scrape run.
//
// ROOT CAUSE: content-script had no cache for Enhanced Mode state. Every
// stall invoked the fallback, which sent a request to background, which read
// chrome.storage.local, which returned "not granted". N stalls × 2 messages
// = 2N wasted messages + 2N log entries per $scrollToBottom.
//
// FIX:
//   (1) createEnhancedModeCache() factory — a pure helper that caches the
//       state after first query, returns the cached value on subsequent
//       calls, supports invalidate() for state changes.
//   (2) trustedWheelFallback uses the cache: if known-disabled, returns
//       {dispatched:false, reason:'enhanced mode disabled'} WITHOUT a
//       round-trip; emits ONE trustedWheel_skipped diagnostic per
//       $scrollToBottom invocation (not per stall).
//   (3) Wizard reads chrome.storage.session flag trustedWheelSkipped after
//       testScript and surfaces a tip: "Enable Enhanced Mode for trusted-
//       wheel scroll fallback."
//
// UNIVERSALITY: pure infrastructure — no site-specific logic, no LLM prompt
// changes. The cache is per-tab-and-content-script-instance.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { createEnhancedModeCache } = require('../lib/renderer-activation');

describe('createEnhancedModeCache — caches Enhanced Mode state to skip wasted round-trips', () => {
  it('returns false by default when no query function is provided', async () => {
    const cache = createEnhancedModeCache({});
    assert.equal(await cache.getState(), false);
  });

  it('returns the query result and caches it', async () => {
    let queryCalls = 0;
    const cache = createEnhancedModeCache({
      query: () => { queryCalls++; return Promise.resolve(true); }
    });
    assert.equal(queryCalls, 0, 'query should not be called at construction');
    const first = await cache.getState();
    assert.equal(first, true);
    assert.equal(queryCalls, 1, 'query called once on first getState');
    const second = await cache.getState();
    assert.equal(second, true);
    assert.equal(queryCalls, 1, 'query NOT called again on second getState');
  });

  it('normalizes non-boolean query results to boolean', async () => {
    const cache = createEnhancedModeCache({
      query: () => Promise.resolve('yes')  // truthy string
    });
    assert.equal(await cache.getState(), true);
    const cache2 = createEnhancedModeCache({
      query: () => Promise.resolve(0)  // falsy number
    });
    assert.equal(await cache2.getState(), false);
  });

  it('is resilient to query throwing — caches false, does not rethrow', async () => {
    const cache = createEnhancedModeCache({
      query: () => Promise.reject(new Error('chrome.runtime unavailable'))
    });
    // getState must not throw synchronously and must resolve (not reject)
    let result;
    try {
      result = await cache.getState();
    } catch (e) {
      assert.fail('getState should not reject on query error: ' + e.message);
    }
    assert.equal(result, false, 'failure to query should default to false');
  });

  it('is resilient to query returning null/undefined — treats as false', async () => {
    const cache = createEnhancedModeCache({
      query: () => Promise.resolve(null)
    });
    assert.equal(await cache.getState(), false);
  });

  it('invalidate() forces re-query on next getState', async () => {
    let queryCalls = 0;
    let currentState = true;
    const cache = createEnhancedModeCache({
      query: () => { queryCalls++; return Promise.resolve(currentState); }
    });
    assert.equal(await cache.getState(), true);
    assert.equal(queryCalls, 1);
    assert.equal(await cache.getState(), true);
    assert.equal(queryCalls, 1, 'cached');
    // Simulate user toggling Enhanced Mode off
    currentState = false;
    cache.invalidate();
    assert.equal(await cache.getState(), false);
    assert.equal(queryCalls, 2, 're-queried after invalidate');
  });

  it('isKnown() reports whether state is currently cached', async () => {
    const cache = createEnhancedModeCache({
      query: () => Promise.resolve(true)
    });
    assert.equal(cache.isKnown(), false);
    await cache.getState();
    assert.equal(cache.isKnown(), true);
    cache.invalidate();
    assert.equal(cache.isKnown(), false);
  });

  it('handles concurrent getState() calls without duplicate queries', async () => {
    // Two concurrent getState() calls (before either resolves) should share
    // a single underlying query — critical for the first scroll stall, where
    // multiple in-flight fallbacks could otherwise each fire a round-trip.
    let queryCalls = 0;
    const cache = createEnhancedModeCache({
      query: () => {
        queryCalls++;
        return new Promise(resolve => setTimeout(() => resolve(true), 10));
      }
    });
    const [a, b] = await Promise.all([cache.getState(), cache.getState()]);
    assert.equal(a, true);
    assert.equal(b, true);
    assert.equal(queryCalls, 1, 'concurrent gets must share one query');
  });
});

describe('createEnhancedModeCache — _setForTest hook', () => {
  it('allows tests to inject known state without a query function', () => {
    const cache = createEnhancedModeCache({});
    cache._setForTest(true);
    assert.equal(cache.isKnown(), true);
    return cache.getState().then(v => assert.equal(v, true));
  });

  it('_setForTest(false) makes isKnown true and getState return false', async () => {
    const cache = createEnhancedModeCache({});
    cache._setForTest(false);
    assert.equal(cache.isKnown(), true);
    assert.equal(await cache.getState(), false);
  });
});
