// PageTracker — owns page identity, dedup, and size-cap enforcement for the
// RC16 output pages-list feature. One instance per service execution.
//
// ID format: page_NNNN_HHHHHHHH
//   NNNN      — zero-padded 4-digit capture sequence (0001, 0002, ...)
//   HHHHHHHH  — first 8 hex chars of SHA-256(url + '\x00' + normalizedHtml)
//
// Two captures with identical (url, normalizedHtml) produce the same hash →
// dedupe to the same page ID. Different URL or different content → new ID.
//
// Size cap (default 50 entries): when the unique-page count exceeds the cap,
// keepFirst = ceil(cap/10) initial entries (for context) + keepLast =
// cap-keepFirst most-recent entries (for activity). pagesTruncated reports
// the count dropped. Per-page HTML cap: 80000 chars (over-cap → truncated).
//
// Opt-out: new PageTracker({ capturePages: false }) makes record() a no-op
// that returns null. listWithMeta() returns empty.

const DEFAULT_MAX_PAGES = 50;
const DEFAULT_HTML_CAP = 80000;
// Total-byte budget for pages[] returned per job. Bounds chrome.storage.local
// growth: without it, 100 retained jobs × 4MB each = 400MB. The unlimitedStorage
// permission removes the hard 10MB cap, but runaway growth would still trash
// the user's disk. The byte budget drops middle entries to stay under threshold.
// Set maxPagesBytes:0 in service config to disable (count cap alone applies).
const DEFAULT_MAX_PAGES_BYTES = 2 * 1024 * 1024;
const TRUNCATION_MARKER_RESERVE = 30; // length of "[TRUNCATED NNNN chars] " worst case

class PageTracker {
  constructor(options = {}) {
    this.capturePages = options.capturePages !== false;
    // Use ?? (nullish-coalescing) so maxPagesCaptured:0 is honored as a real value.
    // (|| would swallow 0 and substitute the default — making the cap<=0 guard
    // in listWithMeta unreachable for the canonical cap=0 case.)
    this.maxPagesCaptured = options.maxPagesCaptured ?? DEFAULT_MAX_PAGES;
    this.htmlCap = options.htmlCap ?? DEFAULT_HTML_CAP;
    // maxPagesBytes:0 disables the byte budget entirely (count cap alone applies).
    this.maxPagesBytes = options.maxPagesBytes ?? DEFAULT_MAX_PAGES_BYTES;
    this._entries = [];      // unique-page records in insertion order
    this._dedupe = new Map(); // hash → pageId
    this._seq = 0;
  }

  // record(snapshot, meta) → pageId (string) or null (when capturePages:false).
  //   snapshot: { html, url, title, ... } — content-script's getDomSnapshot output
  //   meta:     { sourceStepId, captureReason }
  //             sourceStepId is normally the step id from the service graph;
  //             it may also be the sentinel '__opentab__' for sub-tab captures
  //             (see background.js handleOpenTabExecute / captureSubTabSnapshot).
  // If (url, normalizedHtml) matches an existing entry, returns the existing
  // pageId WITHOUT creating a new entry. captureReason of the FIRST capture
  // wins (subsequent dedup hits don't overwrite).
  record(snapshot, meta = {}) {
    if (!this.capturePages) return null;
    if (!snapshot || typeof snapshot !== 'object') return null;
    // Defensive: snapshots without meaningful content produce junk entries that
    // pollute the pages[] list. Require at least an html string of length > 0.
    // (url is allowed to be empty — e.g. about:blank tabs have empty URLs.)
    if (typeof snapshot.html !== 'string' || snapshot.html.length === 0) return null;

    const url = String(snapshot.url || '');
    const rawHtml = String(snapshot.html || '');
    const normalized = normalizeHtmlForHash(rawHtml);
    const hashInput = url + '\x00' + normalized;

    const existing = this._dedupe.get(hashInput);
    if (existing) return existing;

    this._seq++;
    const seq = String(this._seq).padStart(4, '0');
    const fullHash = sha256Hex(hashInput);
    const shortHash = fullHash.slice(0, 8);
    const id = `page_${seq}_${shortHash}`;

    const htmlOverCap = rawHtml.length > this.htmlCap;
    const html = htmlOverCap
      ? `[TRUNCATED ${rawHtml.length} chars] ` + rawHtml.slice(0, this.htmlCap - TRUNCATION_MARKER_RESERVE)
      : rawHtml;

    this._entries.push({
      id,
      url,
      title: String(snapshot.title || ''),
      capturedAt: Date.now(),
      sourceStepId: meta.sourceStepId || null,
      captureReason: meta.captureReason || 'step_iteration',
      hash: fullHash,
      html,
      truncated: htmlOverCap
    });
    this._dedupe.set(hashInput, id);
    return id;
  }

  // Returns the page list with cap enforcement applied.
  // Two passes:
  //   1. Count cap (keepFirst = ceil(cap/10) + keepLast = cap-keepFirst) — preserves
  //      initial state for context + most-recent activity.
  //   2. Byte budget (drops middle entries when total html.length exceeds
  //      maxPagesBytes) — bounds chrome.storage.local growth. Skipped when
  //      maxPagesBytes:0. Always keeps first + last so the user has at least
  //      the initial-state and most-recent captures.
  list() {
    return this.listWithMeta().pages;
  }

  listWithMeta() {
    if (!this.capturePages) return { pages: [], pagesTruncated: 0 };
    if (this.maxPagesCaptured <= 0) {
      // cap=0 means "capture nothing" — return all entries as truncated.
      return { pages: [], pagesTruncated: this._entries.length };
    }
    const total = this._entries.length;
    let pages, truncated;
    if (total <= this.maxPagesCaptured) {
      pages = this._entries.slice();
      truncated = 0;
    } else {
      const keepFirst = Math.ceil(this.maxPagesCaptured / 10);
      const keepLast = this.maxPagesCaptured - keepFirst;
      const first = this._entries.slice(0, keepFirst);
      const last = this._entries.slice(total - keepLast);
      pages = first.concat(last);
      truncated = total - this.maxPagesCaptured;
    }
    if (this.maxPagesBytes > 0) {
      const bytes = pages.reduce((s, p) => s + (p.html ? p.html.length : 0), 0);
      if (bytes > this.maxPagesBytes) {
        const result = enforceByteBudget(pages, this.maxPagesBytes);
        pages = result.pages;
        truncated += result.dropped;
      }
    }
    return { pages, pagesTruncated: truncated };
  }
}

// Drop middle entries from pages[] until total html.length <= budget.
// Always keeps first + last (worst case: 2 entries remaining, possibly still
// over budget — accepted as better than 0 entries).
function enforceByteBudget(pages, budget) {
  if (pages.length <= 2) return { pages, dropped: 0 };
  let bytes = pages.reduce((s, p) => s + (p.html ? p.html.length : 0), 0);
  if (bytes <= budget) return { pages, dropped: 0 };
  const arr = pages.slice();
  let dropped = 0;
  while (arr.length > 2 && bytes > budget) {
    const mid = Math.floor(arr.length / 2);
    bytes -= (arr[mid].html ? arr[mid].html.length : 0);
    arr.splice(mid, 1);
    dropped++;
  }
  return { pages: arr, dropped };
}

// Normalize HTML for hash stability across equivalent re-renders.
//   - trim + collapse whitespace runs
//   - drop volatile attributes (data-reactid, nonce, integrity, long base62 data-* values)
//   - sort attributes within each element alphabetically
// Output is not meant for display — only for hashing.
//
// Implementation note: this is a regex-based pass, not a DOM parse. We
// intentionally avoid jsdom here to keep PageTracker testable in pure Node
// (and to keep runtime cost low). The tradeoff: malformed HTML may hash
// differently than a DOM-aware normalizer would produce. Acceptable because
// the dedup is best-effort — false negatives (two truly-equivalent pages
// hashing differently) only cost an extra entry; they don't break anything.
function normalizeHtmlForHash(html) {
  if (typeof html !== 'string') return '';
  let out = html;
  // Strip HTML comments FIRST, before any attribute-drop regexes. Pages with
  // timestamped/cache-buster comments (e.g. `<!-- built at 2024-01-01T12:00:00 -->`
  // or `<!-- sessionId=abc123 -->`) would otherwise hash differently on every
  // re-render, breaking dedup.
  out = out.replace(/<!--[\s\S]*?-->/g, '');
  // Drop volatile attributes: data-reactid, nonce, integrity, and data-*
  // whose value looks like a long base62 (render IDs, cache busters).
  out = out.replace(/\s+(?:data-reactid|nonce|integrity)="[^"]*"/gi, '');
  out = out.replace(/\s+data-[a-z0-9-]+="[A-Za-z0-9_-]{20,}"/gi, '');
  // Sort attributes within each element tag.
  out = out.replace(/<([a-zA-Z][\w-]*)([^>]*?)(\s*\/?)>/g, (m, tag, attrs, close) => {
    attrs = attrs.trim();
    if (!attrs) return m;
    const list = [];
    // Use (^|\s+) so the first attribute is matched even after the trim above
    // (which strips the leading whitespace the original regex relied on).
    const re = /(?:^|\s+)([a-zA-Z_:][\w:.-]*)\s*=\s*"([^"]*)"/g;
    let am;
    while ((am = re.exec(attrs)) !== null) list.push([am[1], am[2]]);
    // Also capture valueless attributes (e.g. <input disabled>)
    const bareRe = /(?:^|\s+)([a-zA-Z_:][\w:.-]*)(?=\s|$)/g;
    let bm;
    while ((bm = bareRe.exec(attrs)) !== null) {
      if (!list.find(([k]) => k === bm[1])) list.push([bm[1], '']);
    }
    list.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
    const rebuilt = list.map(([k, v]) => v === '' ? ` ${k}` : ` ${k}="${v}"`).join('');
    return `<${tag}${rebuilt}${close}>`;
  });
  // Collapse whitespace runs to a single space and trim.
  out = out.replace(/\s+/g, ' ').trim();
  return out;
}

// sha256Hex(input) → 64-char lowercase hex used for page identity and dedup.
//
// Two paths:
//   - Node (tests, any env where require() works): synchronous SHA-256 via
//     the built-in `crypto` module. Production-quality.
//   - Browser (Service Worker / offscreen doc without Node crypto): a
//     deterministic non-cryptographic FNV-1a-style hash, padded to 64 hex
//     chars. NOT cryptographically secure — but the use here is dedup of
//     <100 entries per execution, where collision probability is negligible.
//
// Note: the `hash` field stored on each page entry is whatever this function
// returns — SHA-256 in test traces, FNV-1a-derived in browser traces. Treat
// it as an opaque stable dedup key, not a cryptographic commitment.
function sha256Hex(input) {
  // Prefer Node's synchronous crypto when available (test environment).
  if (typeof require === 'function') {
    try {
      const nodeCrypto = require('crypto');
      return nodeCrypto.createHash('sha256').update(input, 'utf8').digest('hex');
    } catch { /* fall through */ }
  }
  // Browser sync fallback (FNV-1a, 64 hex chars). Used when running in the
  // Service Worker / offscreen doc without Node crypto. Collisions on real
  // page HTML are astronomically unlikely; this is for dedup, not security.
  let h1 = 0xcbf29ce484222325n;
  let h2 = 0x84222325cbf29ce4n;
  for (let i = 0; i < input.length; i++) {
    const c = BigInt(input.charCodeAt(i));
    h1 = (h1 ^ c) * 0x100000001b3n & 0xFFFFFFFFFFFFFFFFn;
    h2 = (h2 ^ c) * 0x100000001b3n & 0xFFFFFFFFFFFFFFFFn;
  }
  const hex1 = h1.toString(16).padStart(16, '0');
  const hex2 = h2.toString(16).padStart(16, '0');
  return (hex1 + hex2 + hex1 + hex2).slice(0, 64);
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { PageTracker, normalizeHtmlForHash, sha256Hex, enforceByteBudget };
} else if (typeof window !== 'undefined') {
  window.PageTracker = PageTracker;
}
