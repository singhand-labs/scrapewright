// extension/lib/renderer-activation.js
//
// Trusted-wheel fallback (RC19) — the ONLY remaining user of chrome.debugger
// after RC20.
//
// === Current architecture (RC20) ===
//
// Enhanced Scraping Mode is the OPT-IN flag (chrome.storage.local
// `enhancedModeEnabled`) that gates availability of the trusted-wheel
// fallback. When a scrape tab's programmatic `scrollBy` stalls (no content
// growth), `lib/scroll-ops.js` asks the content script to dispatch a trusted
// wheel event. The content script sends TRUSTED_WHEEL_SCROLL_REQUEST to
// background.js, which calls dispatchTrustedWheelScroll below.
//
// Brief tab activation (RC20, lib/tab-activation.js) handles Chrome's hard
// rule that compositor frames are produced only for the active tab in the
// focused window — that's a separate layer and lives in its own module.
//
// === Removed in RC20 ===
//
// activateTabViaDebugger (Page.setWebLifecycleState): was RC18 Plan A.
// Empirically INSUFFICIENT — addresses page-lifecycle layer but not compositor
// frame production. RC20's brief tab activation makes lifecycle naturally
// ACTIVE during the brief window, so the call was pure overhead (yellow
// debugger banner per scrape). Removed along with activateTabIfPermitted.
//
// ===
//
// WHY DEBUGGER IS A REQUIRED PERMISSION (not optional_permissions):
// Chrome's optional_permissions allow-list excludes "debugger" — the manifest
// entry is silently stripped at load, and chrome.permissions.request fails
// with "Only permissions specified in the manifest may be requested". So the
// install-time "may debug your browser" warning is unavoidable. Enhanced
// Mode is opt-in at runtime via the storage flag below, so users who never
// toggle it on never actually use the debugger capability.
//
// DETECTION-RISK MINIMIZATION:
// Anti-bot systems (Cloudflare, DataDome, Akamai) detect CDP usage primarily
// via Runtime.evaluate command traces. This module uses ONLY
// Input.dispatchMouseEvent — never Runtime, Network, DOM, or Emulation.
// Transient attach: attach → sendCommand → detach, target < 100ms total.

(function (global) {
  const DEBUGGER_PROTOCOL_VERSION = '1.3';

  // Storage key for the enhanced-mode opt-in flag. The chrome.debugger
  // permission itself is granted at install time (required); this flag gates
  // *usage* so users can toggle the feature without reinstalling.
  const STORAGE_KEY = 'enhancedModeEnabled';

  function hasStorageApi() {
    return typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local &&
      typeof chrome.storage.local.get === 'function';
  }

  // hasDebuggerPermission(): resolves true iff user has toggled enhanced mode
  // on via the options page. Safe to call in any context (returns false if
  // chrome.storage.local is unavailable, e.g., in test sandboxes).
  async function hasDebuggerPermission() {
    if (!hasStorageApi()) return false;
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get([STORAGE_KEY], (result) => {
          resolve(!!(result && result[STORAGE_KEY]));
        });
      } catch (e) {
        resolve(false);
      }
    });
  }

  // requestDebuggerPermission(): flips the enhanced-mode storage flag on.
  // Named to preserve the original API; no longer calls chrome.permissions
  // because "debugger" cannot be an optional permission.
  async function requestDebuggerPermission() {
    if (!hasStorageApi()) {
      return { granted: false, reason: 'chrome.storage.local unavailable' };
    }
    return new Promise((resolve) => {
      try {
        chrome.storage.local.set({ [STORAGE_KEY]: true }, () => {
          const err = chrome.runtime && chrome.runtime.lastError;
          if (err) {
            resolve({ granted: false, reason: 'lastError: ' + (err.message || err) });
          } else {
            resolve({ granted: true });
          }
        });
      } catch (e) {
        resolve({ granted: false, reason: 'throw: ' + (e && e.message || String(e)) });
      }
    });
  }

  // removeDebuggerPermission(): clears the storage flag. Safe to call from
  // any context.
  async function removeDebuggerPermission() {
    if (!hasStorageApi()) return false;
    return new Promise((resolve) => {
      try {
        chrome.storage.local.remove([STORAGE_KEY], () => {
          resolve(!chrome.runtime.lastError);
        });
      } catch (e) {
        resolve(false);
      }
    });
  }

  // RC19 follow-up (console.log 2026-07-29): CDP sendCommand callbacks for
  // Input.dispatchMouseEvent DO NOT fire on their own for background tabs in
  // some throttled states — the callback only fires when Chrome eventually
  // rejects the command (e.g. when the tab is closed, ~60s later via the
  // orchestrator's timeout, surfacing as "Detached while handling command").
  // Wrap each CDP step in a Promise.race with a hard cap so any hang unblocks
  // within CDP_STEP_TIMEOUT_MS regardless of cause. Generic defense — works
  // for any Chrome version / tab state. For best-effort paths (e.g. hover
  // dismiss), pass a shorter ms via the second arg to avoid eating the
  // per-iteration budget on cleanup that may legitimately never fire on a
  // re-throttled tab.
  const CDP_STEP_TIMEOUT_MS = 2000;
  function withTimeout(promiseFactory, stepLabel, ms) {
    const cap = (typeof ms === 'number' && ms > 0) ? ms : CDP_STEP_TIMEOUT_MS;
    return new Promise(function (resolve, reject) {
      let settled = false;
      const timer = setTimeout(function () {
        if (settled) return;
        settled = true;
        reject(new Error(stepLabel + ' timeout after ' + cap + 'ms'));
      }, cap);
      promiseFactory().then(
        function (v) { if (settled) return; settled = true; clearTimeout(timer); resolve(v); },
        function (e) { if (settled) return; settled = true; clearTimeout(timer); reject(e); }
      );
    });
  }

  // dispatchTrustedWheelScroll(tabId, opts): the RC19 fix for isTrusted-gated
  // lazy-loaders (console.log 2026-07-28).
  //
  // ROOT CAUSE THIS ADDRESSES:
  // After RC12-RC18 fixed every visibility/lifecycle/frame-production layer,
  // Facebook's feed lazy-load still flatlined on programmatic scroll. The
  // user-confirmed disambiguator: manual mouse-wheel scroll DOES load more
  // posts, programmatic el.scrollBy() does NOT. That split can only mean one
  // thing — FB's loader filters on event.isTrusted, which is true only for
  // OS-level input dispatched through Chrome's input pipeline. JS-only scroll
  // produces isTrusted=false events and is ignored. No amount of visibility
  // override or lifecycle activation changes that — it's a separate layer.
  //
  // CDP's Input.dispatchMouseEvent enters the renderer through the same input
  // pipeline as real user input, so the resulting wheel event has
  // isTrusted=true. This is the only programmatic mechanism that produces a
  // trusted wheel event.
  //
  // WHY GENERIC, NOT FB-SPECIFIC:
  // The fix lives entirely in infrastructure (renderer-activation + scroll-ops
  // + content-script + background relay). No site names, no FB-specific DOM
  // assumptions anywhere in the prompt or DSL. The LLM keeps writing
  // `$scrollToBottom`; under the hood, when Enhanced Mode is enabled and the
  // programmatic scroll stalls, we dispatch a trusted wheel event. Any site
  // that gates lazy-load on isTrusted benefits; sites that don't filter are
  // unaffected (programmatic scroll already works for them).
  //
  // NOTE (RC20): tab activation (lib/tab-activation.js) is now a separate
  // prerequisite layer — Input.dispatchMouseEvent requires frame production
  // which requires the tab to be active in the focused window. The content
  // script's withTabActivation wrapper handles that; this function assumes
  // the caller has already activated if needed.
  //
  // Returns { ok, dispatched, attached, detached, reason?, wheelX?, wheelY?,
  //   deltaY? } for diagnostic logging. Never throws.
  async function dispatchTrustedWheelScroll(tabId, opts) {
    opts = opts || {};
    var deltaY = (typeof opts.deltaY === 'number') ? opts.deltaY : 800;
    var x = (typeof opts.x === 'number') ? opts.x : 400;
    var y = (typeof opts.y === 'number') ? opts.y : 400;

    if (typeof chrome === 'undefined' || !chrome.debugger ||
        typeof chrome.debugger.attach !== 'function' ||
        typeof chrome.debugger.sendCommand !== 'function' ||
        typeof chrome.debugger.detach !== 'function') {
      return { ok: false, dispatched: false, reason: 'chrome.debugger unavailable' };
    }
    if (typeof tabId !== 'number' || tabId <= 0) {
      return { ok: false, dispatched: false, reason: 'invalid tabId' };
    }

    // Reuse the same opt-in gate. If Enhanced Mode is off, fast-fail without
    // touching the debugger.
    var permitted = await hasDebuggerPermission();
    if (!permitted) {
      return { ok: false, dispatched: false, reason: 'debugger permission not granted' };
    }

    var target = { tabId: tabId };
    var result = { ok: false, attached: false, dispatched: false, detached: false, wheelX: x, wheelY: y, deltaY: deltaY };

    // 1. Attach
    try {
      await withTimeout(function () {
        return new Promise(function (resolve, reject) {
          chrome.debugger.attach(target, DEBUGGER_PROTOCOL_VERSION, function () {
            var err = chrome.runtime && chrome.runtime.lastError;
            if (err) reject(err); else resolve();
          });
        });
      }, 'wheel.attach');
      result.attached = true;
    } catch (e) {
      return { ok: false, dispatched: false, reason: 'attach failed: ' + (e && e.message || String(e)) };
    }

    // 2. mouseMoved + mouseWheel + 3. always detach in finally
    try {
      // Position the cursor first. CDP requires a mouseMoved before mouseWheel
      // so the renderer knows where the wheel event originates. Without this,
      // some sites that read document:hover never see the wheel target change.
      await withTimeout(function () {
        return new Promise(function (resolve, reject) {
          chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', {
            type: 'mouseMoved',
            x: x, y: y,
            modifier: 0
          }, function () {
            var err = chrome.runtime && chrome.runtime.lastError;
            if (err) reject(err); else resolve();
          });
        });
      }, 'wheel.mouseMoved');

      // The actual wheel event. deltaY > 0 scrolls DOWN (toward end of page),
      // matching user mouse-wheel-down gesture. Chrome converts deltaY in
      // CSS-pixel-like units; ~100 is one wheel notch, ~800 is a fast scroll.
      await withTimeout(function () {
        return new Promise(function (resolve, reject) {
          chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', {
            type: 'mouseWheel',
            x: x, y: y,
            deltaX: 0,
            deltaY: deltaY,
            modifier: 0
          }, function () {
            var err = chrome.runtime && chrome.runtime.lastError;
            if (err) reject(err); else resolve();
          });
        });
      }, 'wheel.mouseWheel');

      result.dispatched = true;
      result.ok = true;
    } catch (e) {
      result.reason = 'wheel dispatch failed: ' + (e && e.message || String(e));
    } finally {
      try {
        await withTimeout(function () {
          return new Promise(function (resolve) {
            chrome.debugger.detach(target, function () { resolve(); });
          });
        }, 'wheel.detach');
        result.detached = true;
      } catch (e) {
        result.detached = false;
        result.detachError = e && e.message || String(e);
      }
    }

    return result;
  }

  // dispatchTrustedHover(tabId, opts): the hover primitive for hovercard
  // enrichment. Same CDP path as dispatchTrustedWheelScroll but WITHOUT the
  // mouseWheel step — hover is a stationary mouseMoved. Used by $hover to
  // trigger JS hover handlers (link preview popovers, hovercards) that filter
  // on event.isTrusted=true. Same Enhanced Mode opt-in gate; same
  // detection-risk minimization (Input.dispatchMouseEvent only, never
  // Runtime/Network/DOM); same 2s per-step timeout.
  //
  // Returns { ok, dispatched, attached, detached, reason?, hoverX?, hoverY? }
  // for diagnostic logging. Never throws.
  async function dispatchTrustedHover(tabId, opts) {
    opts = opts || {};
    var x = (typeof opts.x === 'number') ? opts.x : 400;
    var y = (typeof opts.y === 'number') ? opts.y : 400;

    if (typeof chrome === 'undefined' || !chrome.debugger ||
        typeof chrome.debugger.attach !== 'function' ||
        typeof chrome.debugger.sendCommand !== 'function' ||
        typeof chrome.debugger.detach !== 'function') {
      return { ok: false, attached: false, dispatched: false, detached: false, reason: 'chrome.debugger unavailable' };
    }
    if (typeof tabId !== 'number' || tabId <= 0) {
      return { ok: false, attached: false, dispatched: false, detached: false, reason: 'invalid tabId' };
    }

    var permitted = await hasDebuggerPermission();
    if (!permitted) {
      return { ok: false, attached: false, dispatched: false, detached: false, reason: 'debugger permission not granted' };
    }

    var target = { tabId: tabId };
    var result = { ok: false, attached: false, dispatched: false, detached: false, hoverX: x, hoverY: y };

    try {
      await withTimeout(function () {
        return new Promise(function (resolve, reject) {
          chrome.debugger.attach(target, DEBUGGER_PROTOCOL_VERSION, function () {
            var err = chrome.runtime && chrome.runtime.lastError;
            if (err) reject(err); else resolve();
          });
        });
      }, 'hover.attach');
      result.attached = true;
    } catch (e) {
      return { ok: false, dispatched: false, reason: 'attach failed: ' + (e && e.message || String(e)) };
    }

    try {
      await withTimeout(function () {
        return new Promise(function (resolve, reject) {
          chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', {
            type: 'mouseMoved',
            x: x, y: y,
            modifier: 0
          }, function () {
            var err = chrome.runtime && chrome.runtime.lastError;
            if (err) reject(err); else resolve();
          });
        });
      }, 'hover.mouseMoved');

      result.dispatched = true;
      result.ok = true;
    } catch (e) {
      result.reason = 'hover dispatch failed: ' + (e && e.message || String(e));
    } finally {
      try {
        await withTimeout(function () {
          return new Promise(function (resolve) {
            chrome.debugger.detach(target, function () { resolve(); });
          });
        }, 'hover.detach');
        result.detached = true;
      } catch (e) {
        result.detached = false;
        result.detachError = e && e.message || String(e);
      }
    }

    return result;
  }

  // dispatchTrustedHoverDismiss(tabId): moves the trusted cursor to (1,1) so
  // JS hover handlers fire mouseout/mouseleave and close the popover. Same
  // CDP path + Enhanced Mode gate + detection-risk profile as the other
  // dispatch* helpers. Used by $hover after extracting the popover HTML so
  // the popover doesn't linger into the next iteration.
  async function dispatchTrustedHoverDismiss(tabId) {
    if (typeof chrome === 'undefined' || !chrome.debugger ||
        typeof chrome.debugger.attach !== 'function' ||
        typeof chrome.debugger.sendCommand !== 'function' ||
        typeof chrome.debugger.detach !== 'function') {
      return { ok: false, attached: false, dispatched: false, detached: false, reason: 'chrome.debugger unavailable' };
    }
    if (typeof tabId !== 'number' || tabId <= 0) {
      return { ok: false, attached: false, dispatched: false, detached: false, reason: 'invalid tabId' };
    }

    var permitted = await hasDebuggerPermission();
    if (!permitted) {
      return { ok: false, attached: false, dispatched: false, detached: false, reason: 'debugger permission not granted' };
    }

    var target = { tabId: tabId };
    var result = { ok: false, attached: false, dispatched: false, detached: false };

    try {
      await withTimeout(function () {
        return new Promise(function (resolve, reject) {
          chrome.debugger.attach(target, DEBUGGER_PROTOCOL_VERSION, function () {
            var err = chrome.runtime && chrome.runtime.lastError;
            if (err) reject(err); else resolve();
          });
        });
      }, 'hoverDismiss.attach');
      result.attached = true;
    } catch (e) {
      return { ok: false, dispatched: false, reason: 'attach failed: ' + (e && e.message || String(e)) };
    }

    try {
      await withTimeout(function () {
        return new Promise(function (resolve, reject) {
          chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', {
            type: 'mouseMoved',
            x: 1, y: 1,
            modifier: 0
          }, function () {
            var err = chrome.runtime && chrome.runtime.lastError;
            if (err) reject(err); else resolve();
          });
        });
      }, 'hoverDismiss.mouseMoved', 500);

      result.dispatched = true;
      result.ok = true;
    } catch (e) {
      result.reason = 'hover dismiss failed: ' + (e && e.message || String(e));
    } finally {
      try {
        await withTimeout(function () {
          return new Promise(function (resolve) {
            chrome.debugger.detach(target, function () { resolve(); });
          });
        }, 'hoverDismiss.detach', 500);
        result.detached = true;
      } catch (e) {
        result.detached = false;
        result.detachError = e && e.message || String(e);
      }
    }

    return result;
  }

  // createEnhancedModeCache({query}): lazy cache for the Enhanced Mode state.
  // console.log 2026-08-04: every scroll stall in an Enhanced-Mode-off run
  // was producing a full message round-trip (content-script → background →
  // chrome.storage.local → response) just to learn "debugger permission not
  // granted". Across a single FB scrape, dozens of wasted round-trips. This
  // factory returns a cache object the content-script can hold at module
  // scope: the first getState() queries via `opts.query`, subsequent calls
  // return the cached value, invalidate() forces re-query (used when the
  // user toggles Enhanced Mode mid-session).
  //
  // Concurrency-safe: if two getState() calls arrive before the first query
  // resolves, they share the same underlying promise (one query, not two).
  // Critical for the first scroll stall, where multiple in-flight fallbacks
  // could otherwise each fire a round-trip.
  //
  // Failure-safe: if `query` throws or rejects, getState() resolves false
  // (conservative — trusted-wheel just won't fire, scrape continues).
  function createEnhancedModeCache(opts) {
    opts = opts || {};
    var queryFn = (typeof opts.query === 'function') ? opts.query : null;
    var cachedState = null; // null = unknown, true/false = known
    var inFlightPromise = null;

    function resolveQuery() {
      if (!queryFn) return Promise.resolve(false);
      try {
        var p = queryFn();
        if (!p || typeof p.then !== 'function') p = Promise.resolve(p);
        return p.then(
          function (v) { return !!v; },
          function () { return false; }
        );
      } catch (e) {
        return Promise.resolve(false);
      }
    }

    return {
      isKnown: function () { return cachedState !== null; },
      getState: function () {
        if (cachedState !== null) return Promise.resolve(cachedState);
        if (!inFlightPromise) {
          inFlightPromise = resolveQuery().then(function (v) {
            cachedState = v;
            inFlightPromise = null;
            return v;
          });
        }
        return inFlightPromise;
      },
      invalidate: function () {
        cachedState = null;
        // Leave inFlightPromise alone — if a query is mid-flight, let it
        // settle (it will set cachedState, which invalidate() will have
        // already cleared; the next getState() after settle will re-query
        // only if cachedState is still null, but in the common case the
        // user toggles Enhanced Mode between scrapes, not mid-stall).
      },
      _setForTest: function (v) { cachedState = !!v; inFlightPromise = null; }
    };
  }

  const api = {
    hasDebuggerPermission: hasDebuggerPermission,
    requestDebuggerPermission: requestDebuggerPermission,
    removeDebuggerPermission: removeDebuggerPermission,
    dispatchTrustedWheelScroll: dispatchTrustedWheelScroll,
    dispatchTrustedHover: dispatchTrustedHover,
    dispatchTrustedHoverDismiss: dispatchTrustedHoverDismiss,
    createEnhancedModeCache: createEnhancedModeCache,
    DEBUGGER_PROTOCOL_VERSION: DEBUGGER_PROTOCOL_VERSION,
    CDP_STEP_TIMEOUT_MS: CDP_STEP_TIMEOUT_MS
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') {
    window.RendererActivation = api;
    window.dispatchTrustedWheelScroll = dispatchTrustedWheelScroll;
    window.dispatchTrustedHover = dispatchTrustedHover;
    window.dispatchTrustedHoverDismiss = dispatchTrustedHoverDismiss;
    window.hasDebuggerPermission = hasDebuggerPermission;
    window.requestDebuggerPermission = requestDebuggerPermission;
    window.removeDebuggerPermission = removeDebuggerPermission;
    window.createEnhancedModeCache = createEnhancedModeCache;
  }
  if (typeof self !== 'undefined') {
    self.RendererActivation = api;
    self.dispatchTrustedWheelScroll = dispatchTrustedWheelScroll;
    self.dispatchTrustedHover = dispatchTrustedHover;
    self.dispatchTrustedHoverDismiss = dispatchTrustedHoverDismiss;
    self.hasDebuggerPermission = hasDebuggerPermission;
    self.requestDebuggerPermission = requestDebuggerPermission;
    self.removeDebuggerPermission = removeDebuggerPermission;
    self.createEnhancedModeCache = createEnhancedModeCache;
  }
  if (typeof global !== 'undefined') {
    global.RendererActivation = api;
    global.dispatchTrustedWheelScroll = dispatchTrustedWheelScroll;
    global.dispatchTrustedHover = dispatchTrustedHover;
    global.dispatchTrustedHoverDismiss = dispatchTrustedHoverDismiss;
    global.hasDebuggerPermission = hasDebuggerPermission;
    global.requestDebuggerPermission = requestDebuggerPermission;
    global.removeDebuggerPermission = removeDebuggerPermission;
    global.createEnhancedModeCache = createEnhancedModeCache;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
