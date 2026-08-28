// URL normalization for the $openTab infrastructure boundary.
//
// Generated scripts commonly receive href values exactly as the page exposes
// them, including root-relative and path-relative links. chrome.tabs.create()
// must never receive those values unresolved: in an extension service worker
// they can resolve against the extension origin, where the Scrapewright
// content script is not injected, and surface as CONTENT_SCRIPT_NOT_READY.

(function (global) {
  function isHttpProtocol(protocol) {
    return protocol === 'http:' || protocol === 'https:';
  }

  function resolveOpenTabUrl(rawUrl, parentUrl) {
    if (typeof rawUrl !== 'string' || !rawUrl.trim()) {
      throw new Error('INVALID_OPEN_TAB_URL: expected a non-empty string');
    }

    const candidate = rawUrl.trim();
    let resolved;

    try {
      // Absolute URLs do not need a parent. Relative URLs deliberately fail
      // here and fall through to the parent-origin resolution below.
      resolved = new URL(candidate);
    } catch (_) {
      if (typeof parentUrl !== 'string' || !parentUrl.trim()) {
        throw new Error('INVALID_OPEN_TAB_URL: relative URL requires a parent page URL');
      }

      let parent;
      try {
        parent = new URL(parentUrl);
      } catch (_) {
        throw new Error('INVALID_OPEN_TAB_URL: parent page URL is invalid');
      }
      if (!isHttpProtocol(parent.protocol)) {
        throw new Error('INVALID_OPEN_TAB_URL: parent page must use HTTP(S)');
      }

      try {
        resolved = new URL(candidate, parent);
      } catch (_) {
        throw new Error('INVALID_OPEN_TAB_URL: URL could not be resolved');
      }
    }

    if (!isHttpProtocol(resolved.protocol)) {
      throw new Error('INVALID_OPEN_TAB_URL: only HTTP(S) destinations are allowed');
    }
    return resolved.href;
  }

  const api = { resolveOpenTabUrl };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof global !== 'undefined') global.OpenTabUrl = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
