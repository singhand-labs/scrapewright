// RC47 audit: domHover early-exit when no hover signal observed after a
// sustained dwell window.
//
// FOLLOWUP to RC46 (post-RC45). console.log 2026-08-13 04:43-05:13 showed
// $extractWithHover taking ~10 minutes per step-4 run because the LLM's
// anchorSel was overly broad (a generic role+href fragment that matched
// most links on the target site). 89% of iterations had `addedNodes:0` (no
// portal mount) yet the polling loop ran the full 3000ms timeout per anchor.
// With ~10 anchors per container × multiple containers, step 4 burnt 5-10
// minutes per autoFix iteration, often timing out before completion.
//
// Real hovercards mount in 600-1600ms (per the same log's 4 successful
// captures at dwellMs 578, 1260, 1319, 1560). If by 1500ms no signal has
// appeared (no MutationObserver additions AND no popoverSel match), the
// anchor almost certainly has no hovercard. Continuing to poll until 3000ms
// is pure waste.
//
// Fix: early-exit path. After NO_SIGNAL_EARLY_EXIT_MS of polling with zero
// signals, break with reason 'no_hover_signal_early_exit'. Saves ~1.5s per
// no-hovercard anchor, cutting step-4 time roughly in half on broad selectors.
//
// Signal definition: ANY of
//   - addedNodes.length > 0 (MutationObserver caught a portal mount)
//   - popoverSel match currently visible (path (a) is in flight, waiting
//     for content/stability gates to pass — don't abandon)
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

describe('RC47: domHover defines a no-signal early-exit threshold', () => {
  // Without a named constant, future maintainers tuning the polling loop
  // won't know that 1500ms is the empirical "real hovercards have mounted
  // by now" cutoff. The constant name documents the intent.

  it('declares NO_SIGNAL_EARLY_EXIT_MS as a named constant', () => {
    const body = sliceDomHover(readSrc('content-script.js'));
    assert.ok(/NO_SIGNAL_EARLY_EXIT_MS|NO_SIGNAL_EARLY_EXIT|EARLY_EXIT_MS\s*=\s*\d+/.test(body),
      'domHover must declare a named constant for the no-signal early-exit threshold ' +
      '(e.g. NO_SIGNAL_EARLY_EXIT_MS = 1500).');
  });

  it('early-exit threshold is >= 1200ms and <= 2000ms', () => {
    // Real hovercards mount in 600-1600ms. Threshold must be:
    //   - high enough to admit slow-but-real mounts (>= 1200ms)
    //   - low enough to actually save time vs the 3000ms default (< 2000ms)
    const body = sliceDomHover(readSrc('content-script.js'));
    const m = body.match(/NO_SIGNAL_EARLY_EXIT_MS\s*=\s*(\d+)/);
    assert.ok(m, 'NO_SIGNAL_EARLY_EXIT_MS = <number> must be declared');
    const val = parseInt(m[1], 10);
    assert.ok(val >= 1200 && val <= 2000,
      'NO_SIGNAL_EARLY_EXIT_MS must be in [1200, 2000] (real hovercards mount in 600-1600ms). Got: ' + val);
  });
});

describe('RC47: domHover breaks the polling loop when no signal is observed past threshold', () => {
  // The polling loop MUST have a guarded break that fires when:
  //   - dwellMs > NO_SIGNAL_EARLY_EXIT_MS
  //   - addedNodes.length === 0 (no MutationObserver activity)
  //   - path (a) has no current visible popoverSel match
  // Without all three conditions, breaking would risk abandoning real
  // hovercards that are mid-mount or pre-allocated.

  it('polling loop body contains an early-exit branch', () => {
    const body = sliceDomHover(readSrc('content-script.js'));
    // The branch must reference the named constant and break.
    assert.ok(/NO_SIGNAL_EARLY_EXIT_MS|NO_SIGNAL_EARLY_EXIT|EARLY_EXIT_MS/.test(body),
      'polling loop must reference the NO_SIGNAL_EARLY_EXIT_MS constant.');
    // The break must be conditional on dwellMs and addedNodes.length === 0
    assert.ok(/dwellMs\s*>\s*NO_SIGNAL_EARLY_EXIT_MS|dwellMs\s*>\s*EARLY_EXIT_MS/.test(body),
      'early-exit must be gated on dwellMs > NO_SIGNAL_EARLY_EXIT_MS.');
    assert.ok(/addedNodes\.length\s*===\s*0|addedNodes\.length\s*<\s*1/.test(body),
      'early-exit must require addedNodes.length === 0 (no MutationObserver activity).');
  });

  it('early-exit preserves path (a) popoverSel matching (RC39 pre-allocated portal)', () => {
    // RC39 scenario: portal pre-allocated at page load, shown via CSS toggle
    // on hover. MutationObserver never fires (no DOM additions). Path (a)
    // popoverSel match is the only signal. Early-exit MUST NOT fire if path
    // (a) currently has a visible match (even if gates haven't passed yet —
    // gates need time for content/stability to converge).
    const body = sliceDomHover(readSrc('content-script.js'));
    // Find the early-exit block and verify it checks path (a) match
    const earlyExitIdx = body.indexOf('NO_SIGNAL_EARLY_EXIT_MS');
    assert.ok(earlyExitIdx > -1, 'NO_SIGNAL_EARLY_EXIT_MS must be referenced');
    // Look at the 1500 chars after the early-exit reference to find the break logic
    const earlyExitBlock = body.slice(earlyExitIdx, earlyExitIdx + 1500);
    assert.ok(/popoverSel/.test(earlyExitBlock),
      'early-exit block must reference popoverSel — RC39 pre-allocated portals rely on path (a) match.');
    // The block must check whether path (a) found something visible
    assert.ok(/isElementVisible|isVisible|querySelectorDeep\s*\(\s*popoverSel/.test(earlyExitBlock),
      'early-exit must check whether path (a) has a visible popoverSel match before breaking. ' +
      'Without this check, RC39 pre-allocated portals that mount slowly would be abandoned.');
  });
});

describe('RC47: domHover surfaces a named reason for early-exit in the result', () => {
  // The result.reason field flows into the LLM's autoFix context. A named
  // reason 'no_hover_signal_early_exit' tells the LLM "this anchor has no
  // hovercard" — distinct from 'popover_timeout' which means "we waited the
  // full budget". The distinction matters for diagnosis.

  it('result.reason can be set to no_hover_signal_early_exit (or similarly named)', () => {
    const body = sliceDomHover(readSrc('content-script.js'));
    assert.ok(/no_hover_signal_early_exit|no_signal_early_exit|early_exit_no_signal/i.test(body),
      'domHover must surface a named reason for early-exit (e.g. no_hover_signal_early_exit). ' +
      'This distinguishes "anchor has no hovercard" from "we waited the full budget" in the ' +
      'autoFix diagnostic context.');
  });
});

describe('RC47: universality — no site-specific terms', () => {
  const SITE_NAMES = ['facebook', 'twitter', 'linkedin', 'tiktok', 'reddit',
    'instagram', 'weibo', 'zhihu', 'douyin'];
  const SITE_ABBREV = ['fb', 'ig'];
  const FORBIDDEN = new RegExp(
    '\\b(' + SITE_NAMES.join('|') + ')\\b|\\b(' + SITE_ABBREV.join('|') + ')\\b',
    'gi'
  );

  it('content-script.js domHover body has no site-specific terms', () => {
    const body = sliceDomHover(readSrc('content-script.js'));
    const matches = body.match(FORBIDDEN) || [];
    assert.deepEqual(matches, [],
      'domHover body must contain no site-specific terms. Found: ' + JSON.stringify(matches));
  });

  it('this test file has no site-specific prose beyond the universality guard itself', () => {
    const self = fs.readFileSync(__filename, 'utf8');
    const stripped = self
      .replace(/const SITE_NAMES[\s\S]*?;/, '')
      .replace(/const SITE_ABBREV[\s\S]*?;/, '')
      .replace(/const FORBIDDEN[\s\S]*?;/, '');
    const matches = stripped.match(FORBIDDEN) || [];
    assert.deepEqual(matches, [],
      'RC47 test file must not use site-specific terms outside the universality-guard character class. ' +
      'Found: ' + JSON.stringify(matches));
  });
});
