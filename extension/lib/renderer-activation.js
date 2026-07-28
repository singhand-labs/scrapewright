// extension/lib/renderer-activation.js
//
// Transient chrome.debugger-based activation. Prevents Chrome's tab lifecycle
// management from throttling/freezing scrape tabs beyond what popup-window
// (RC17) + visibility-keepalive (RC13/RC16) already do.
//
// WHY THIS EXISTS (RC17+ — console.log 2026-07-27 17:02):
// Even with popup-window + visibility-keepalive override, some sites with
// aggressive lazy-load still don't fully render because Chrome's renderer
// process de-prioritizes tabs it considers hidden/inactive at the lifecycle
// layer. CDP's Page.setWebLifecycleState({state:'active'}) tells Chrome's
// lifecycle manager to treat the tab as actively used, preventing intensive
// throttling after the 5-minute inactivity threshold.
//
// DETECTION-RISK MINIMIZATION (user requirement 2026-07-28):
// Anti-bot systems (Cloudflare, DataDome, Akamai) detect CDP usage primarily
// via Runtime.evaluate command traces. This module:
//   1. Uses ONLY Page.* commands — never Runtime, Network, DOM, or Emulation
//   2. Transient attach: attach → sendCommand → detach, target < 100ms total
//      Anti-bot scans for CDP are typically periodic (per second/minute);
//      transient attaches are mostly invisible to them.
//   3. Detaches even on error — never leaves the yellow "extension is
//      debugging this browser" banner visible (UX + minor detection signal).
//   4. Requires explicit user opt-in via chrome.storage.local flag — never silent.
//
// WHY DEBUGGER IS A REQUIRED PERMISSION (not optional_permissions):
// Chrome's optional_permissions allow-list excludes "debugger" — the manifest
// entry is silently stripped at load, and chrome.permissions.request fails
// with "Only permissions specified in the manifest may be requested". So the
// install-time "may debug your browser" warning is unavoidable for users of
// this extension. Trade-off accepted: enhanced scraping mode is opt-in at
// runtime via a chrome.storage.local flag (the options-page toggle) so users
// who don't toggle it on never actually use the debugger capability, even
// though Chrome grants the permission at install time.
//
// FALLBACK CHAIN (when debugger flag not enabled or attach fails):
//   1. Try chrome.debugger transient activation
//   2. Fall back silently to RC17 popup-window + visibility-keepalive
//   3. Log warn so operator knows activation didn't fire (but don't fail)
//
// WHY OPTIONAL_PERMISSION (not permissions):
// Adding "debugger" to permissions triggers a scary install-time warning.
// Using optional_permissions + chrome.permissions.request lets users install
// normally, then decide whether to grant debugger access from the options
// page when they need the enhanced scraping mode.
// NOTE (2026-07-28): the optional_permissions approach DOES NOT WORK for
// "debugger" — Chrome silently strips it from the manifest at load time.
// The permission is now required at install. The runtime toggle below still
// gates *usage* via a storage flag, so the toggle remains meaningful.

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

  // activateTabViaDebugger(tabId): the load-bearing operation. Transiently
  // attaches chrome.debugger to the tab, sends Page.setWebLifecycleState to
  // mark the tab as 'active' (preventing intensive throttling), then
  // immediately detaches. Total attach window target: < 100ms.
  //
  // Returns { ok, reason?, attached?, sendCommand?, detached? } for
  // diagnostic logging. Never throws — caller doesn't need to try/catch.
  async function activateTabViaDebugger(tabId) {
    if (typeof chrome === 'undefined' || !chrome.debugger ||
        typeof chrome.debugger.attach !== 'function' ||
        typeof chrome.debugger.sendCommand !== 'function' ||
        typeof chrome.debugger.detach !== 'function') {
      return { ok: false, reason: 'chrome.debugger unavailable' };
    }
    if (typeof tabId !== 'number' || tabId <= 0) {
      return { ok: false, reason: 'invalid tabId' };
    }
    const target = { tabId };
    const result = { ok: false, attached: false, sendCommand: false, detached: false };

    // 1. Attach
    try {
      await new Promise((resolve, reject) => {
        chrome.debugger.attach(target, DEBUGGER_PROTOCOL_VERSION, () => {
          const err = chrome.runtime && chrome.runtime.lastError;
          if (err) reject(err);
          else resolve();
        });
      });
      result.attached = true;
    } catch (e) {
      // Most common failure: "Another debugger is already attached" (DevTools
      // open, or another extension using chrome.debugger). Non-fatal — log
      // and return; the existing popup-window path is still in effect.
      return { ok: false, reason: 'attach failed: ' + (e && e.message || String(e)), attached: false };
    }

    // 2. Send the load-bearing command + 3. always detach in finally
    try {
      // Page.setWebLifecycleState is a state-setting command; doesn't require
      // prior Page.enable. It transitions the tab's lifecycle to 'active',
      // which Chrome interprets as "user is using this tab right now" and
      // lifts the 5-minute intensive-throttling freeze threshold.
      await new Promise((resolve, reject) => {
        chrome.debugger.sendCommand(target, 'Page.setWebLifecycleState', { state: 'active' }, () => {
          const err = chrome.runtime && chrome.runtime.lastError;
          if (err) reject(err);
          else resolve();
        });
      });
      result.sendCommand = true;
      result.ok = true;
    } catch (e) {
      result.reason = 'sendCommand failed: ' + (e && e.message || String(e));
    } finally {
      // ALWAYS detach. Persistent attach leaves the yellow banner visible
      // ("extension is debugging this browser"), which is both a UX cost
      // and a (minor) detection signal that anti-bot could fingerprint.
      try {
        await new Promise((resolve) => {
          chrome.debugger.detach(target, () => { resolve(); });
        });
        result.detached = true;
      } catch (e) {
        // Detach failure is non-fatal — Chrome auto-detaches when the tab
        // navigates/closes. Just note it in the result.
        result.detached = false;
        result.detachError = e && e.message || String(e);
      }
    }

    return result;
  }

  // activateTabIfPermitted(tabId): convenience wrapper used by scrape-tab.js.
  // Checks permission first; if not granted, returns ok:false with a stable
  // reason ('debugger permission not granted') that callers can suppress
  // from logs (it's the expected state for users who didn't opt in).
  async function activateTabIfPermitted(tabId) {
    const permitted = await hasDebuggerPermission();
    if (!permitted) {
      return { ok: false, reason: 'debugger permission not granted' };
    }
    return await activateTabViaDebugger(tabId);
  }

  const api = {
    hasDebuggerPermission: hasDebuggerPermission,
    requestDebuggerPermission: requestDebuggerPermission,
    removeDebuggerPermission: removeDebuggerPermission,
    activateTabViaDebugger: activateTabViaDebugger,
    activateTabIfPermitted: activateTabIfPermitted,
    DEBUGGER_PROTOCOL_VERSION: DEBUGGER_PROTOCOL_VERSION
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') {
    window.RendererActivation = api;
    window.activateTabIfPermitted = activateTabIfPermitted;
    window.hasDebuggerPermission = hasDebuggerPermission;
    window.requestDebuggerPermission = requestDebuggerPermission;
    window.removeDebuggerPermission = removeDebuggerPermission;
  }
  if (typeof self !== 'undefined') {
    self.RendererActivation = api;
    self.activateTabIfPermitted = activateTabIfPermitted;
    self.hasDebuggerPermission = hasDebuggerPermission;
    self.requestDebuggerPermission = requestDebuggerPermission;
    self.removeDebuggerPermission = removeDebuggerPermission;
  }
  if (typeof global !== 'undefined') {
    global.RendererActivation = api;
    global.activateTabIfPermitted = activateTabIfPermitted;
    global.hasDebuggerPermission = hasDebuggerPermission;
    global.requestDebuggerPermission = requestDebuggerPermission;
    global.removeDebuggerPermission = removeDebuggerPermission;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
