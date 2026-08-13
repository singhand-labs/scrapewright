// RC50 audit: dismiss path must be wrapped in withTabActivation, same as hover.
//
// FOLLOWUP to RC49 (post-RC48). console.log 2026-08-13 13:24-28 showed
// $extractWithHover capturing hovercards (RC49 working) BUT 100% of dismiss
// attempts timing out at 2000ms: "hover dismiss failed: hoverDismiss.mouseMoved
// timeout after 2000ms" on every dismiss (10/10 events sampled). RC48 raised
// the timeout from 500ms to 2000ms; still failing.
//
// Root cause: asymmetric withTabActivation wrapping between hover and dismiss.
// The hover path wraps its TRUSTED_HOVER_REQUEST in withTabActivation (RC20
// architectural fix — line 1869 of content-script.js). The dismiss path at
// line 2301 does NOT wrap its TRUSTED_HOVER_DISMISS. CDP Input.dispatchMouseEvent
// on a background tab hangs because Chrome only produces compositor frames
// for the active tab in the focused window. The mouseMoved callback never
// fires because the input event requires a frame to be processed. Same CDP
// command (Input.dispatchMouseEvent mouseMoved), same tab, same debugger
// — hover succeeds (active tab), dismiss hangs (background tab).
//
// This is the SAME class of asymmetry RC48 documented and fixed (asymmetric
// timeouts between hover and dismiss). RC50 fixes the parallel asymmetry
// at the RC20 tab-activation layer.
//
// Why dismiss-on-background matters even though hover activated the tab:
// hover's withTabActivation block releases when the hover dispatch resolves.
// The polling loop then runs for 1-3 seconds. During polling, the user may
// switch tabs (or the OS may background the window). By the time dismiss
// fires, the tab is no longer active. The dismiss's CDP command then hits
// the background-tab throttle.
//
// Fix: wrap the dismiss sendMessage in withTabActivation('hoverDismiss', ...).
// Same wrapper, same label namespace, same activation semantics as hover.
//
// Source-text audit pattern: domHover runs in the content script where
// chrome.* + page DOM are available, so unit tests cannot exercise it
// directly. Audit by slicing the polling loop body from the source.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

function readSrc(rel) {
  return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
}

function sliceDomHover(src) {
  const start = src.indexOf('async function domHover(');
  const end = src.indexOf('async function domOpenTab(', start);
  assert.ok(start > -1 && end > start, 'domHover must be sliceable');
  return src.slice(start, end);
}

describe('RC50: dismiss sendMessage is wrapped in withTabActivation', () => {
  // Without the wrapper, dismiss runs on a background tab. CDP
  // Input.dispatchMouseEvent on a background tab hangs because Chrome only
  // produces compositor frames for the active tab in the focused window
  // (RC20 architectural rule). console.log 2026-08-13 13:24-28 showed 100%
  // dismiss failure (10/10 events) despite RC48 raising the timeout to 2000ms.

  it('TRUSTED_HOVER_DISMISS sendMessage is inside a withTabActivation call', () => {
    const body = sliceDomHover(readSrc('content-script.js'));
    const dismissIdx = body.indexOf("type: 'TRUSTED_HOVER_DISMISS'");
    assert.ok(dismissIdx > -1, 'TRUSTED_HOVER_DISMISS sendMessage must exist');
    // Look 400 chars BEFORE the dismiss call — withTabActivation wraps the
    // call as `withTabActivation('label', async () => { ... sendMessage ... })`.
    // The wrapper opens before the sendMessage and closes after.
    const before = body.slice(Math.max(0, dismissIdx - 400), dismissIdx);
    assert.ok(/withTabActivation\(['"]hoverDismiss['"]|withTabActivation\(['"]dismiss['"]/.test(before),
      'TRUSTED_HOVER_DISMISS sendMessage must be wrapped in withTabActivation("hoverDismiss", ...) ' +
      '(or equivalent dismiss label). Same RC20 architectural rule that applies to hover applies to dismiss — ' +
      'CDP Input.dispatchMouseEvent on a background tab hangs because Chrome only produces compositor ' +
      'frames for the active tab in the focused window.');
  });

  it('hover path is ALSO wrapped (control — documents the symmetric pattern)', () => {
    // This test documents the existing hover pattern. If a future refactor
    // removes the hover's wrapper, this test fails — preventing the asymmetry
    // from inverting (hover unwrapped, dismiss wrapped).
    const body = sliceDomHover(readSrc('content-script.js'));
    const hoverIdx = body.indexOf("type: 'TRUSTED_HOVER_REQUEST'");
    assert.ok(hoverIdx > -1, 'TRUSTED_HOVER_REQUEST sendMessage must exist');
    const before = body.slice(Math.max(0, hoverIdx - 400), hoverIdx);
    assert.ok(/withTabActivation\(['"]hover['"]/.test(before),
      'TRUSTED_HOVER_REQUEST sendMessage must remain wrapped in withTabActivation("hover", ...). ' +
      'RC50 symmetry: BOTH hover and dismiss need the wrapper.');
  });
});

describe('RC50: comment documents the RC20 asymmetry fix', () => {
  // Without a comment citing RC20 or the background-tab hang, future
  // maintainers may remove the wrapper as "unnecessary duplication" and
  // reintroduce the hang.

  it('dismiss block comment mentions RC50 OR RC20 OR background-tab/compositor-frame', () => {
    const body = sliceDomHover(readSrc('content-script.js'));
    const dismissIdx = body.indexOf("type: 'TRUSTED_HOVER_DISMISS'");
    assert.ok(dismissIdx > -1, 'TRUSTED_HOVER_DISMISS must exist');
    // Look in a 600-char window BEFORE the dismiss call to find the comment.
    const before = body.slice(Math.max(0, dismissIdx - 600), dismissIdx);
    const hasRC50 = /RC50/.test(before);
    const hasRC20 = /RC20/.test(before);
    const hasBackgroundTab = /background.?tab/i.test(before);
    const hasCompositor = /compositor|frame.?production/i.test(before);
    assert.ok(hasRC50 || hasRC20 || hasBackgroundTab || hasCompositor,
      'dismiss block comment must document WHY withTabActivation is required. ' +
      'Reference RC50, RC20, background-tab, or compositor-frame production.');
  });
});

describe('RC50: universality — no site-specific terms', () => {
  const SITE_NAMES = ['facebook', 'twitter', 'linkedin', 'tiktok', 'reddit',
    'instagram', 'weibo', 'zhihu', 'douyin'];
  const SITE_ABBREV = ['fb', 'ig'];
  const FORBIDDEN = new RegExp(
    '\\b(' + SITE_NAMES.join('|') + ')\\b|\\b(' + SITE_ABBREV.join('|') + ')\\b',
    'gi'
  );

  it('this test file has no site-specific prose beyond the universality guard itself', () => {
    const self = fs.readFileSync(__filename, 'utf8');
    const stripped = self
      .replace(/const SITE_NAMES[\s\S]*?;/, '')
      .replace(/const SITE_ABBREV[\s\S]*?;/, '')
      .replace(/const FORBIDDEN[\s\S]*?;/, '');
    const matches = stripped.match(FORBIDDEN) || [];
    assert.deepEqual(matches, [],
      'RC50 test file must not use site-specific terms outside the universality-guard character class. ' +
      'Found: ' + JSON.stringify(matches));
  });
});
