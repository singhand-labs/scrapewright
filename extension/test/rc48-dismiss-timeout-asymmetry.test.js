// RC48 audit: dismiss-path CDP timeout must match hover-path budget.
//
// FOLLOWUP to RC47 (post-RC46). console.log 2026-08-13 06:24-06:33 showed
// $extractWithHover capturing hovercards for only 1/14 posts in the first
// autoFix iteration, then 0/13 in the final iteration. 58/59 dismiss
// attempts failed with `hoverDismiss.mouseMoved timeout after 500ms` —
// a 98% failure rate.
//
// Root cause: asymmetric CDP step budgets between hover and dismiss paths
// in lib/renderer-activation.js. The hover path uses the default
// CDP_STEP_TIMEOUT_MS (2000ms) for attach/mouseMoved/detach. The dismiss
// path uses 2000ms for attach but overrides mouseMoved AND detach to 500ms.
//
// The 500ms override was a speculative "best-effort cleanup, don't eat
// iteration budget" choice. Empirically wrong: same CDP command, same tab,
// same network — the hover's mouseMoved succeeds at <2000ms while the
// dismiss's mouseMoved times out at >500ms. Cold-debugger-after-detach
// re-init easily exceeds 500ms on the first sendCommand.
//
// Why this matters for hovercard capture: dismiss is "best-effort" for
// htmlSnippet (already captured before dismiss) but NOT best-effort for
// subsequent hover correctness. Failed dismisses leave the previous
// hovercard mounted. The target site's hover state machine then either
// reuses the existing popover (no new MutationObserver event for the next
// anchor) or suppresses subsequent hover mounts. Either way, every hover
// after the first failed dismiss produces empty results.
//
// Fix: remove the 500ms override. Let dismiss use the default 2000ms —
// matching the hover path. There is no principled reason for asymmetric
// budgets on the same CDP command.
//
// Source-text audit pattern: dispatchTrustedHover / dispatchTrustedHoverDismiss
// run in the content-script context where chrome.debugger is available, so
// unit tests cannot exercise them directly. Audit by slicing the source.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

function readSrc(rel) {
  return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
}

function sliceDispatchTrustedHoverDismiss(src) {
  // Start at the comment block ABOVE the function definition so the RC48
  // comment (which documents the WHY) is included in the slice. The comment
  // begins with `// dispatchTrustedHoverDismiss(tabId):` — find that marker
  // and slice forward.
  const marker = '// dispatchTrustedHoverDismiss(tabId):';
  const commentStart = src.indexOf(marker);
  assert.ok(commentStart > -1, 'dispatchTrustedHoverDismiss comment must exist');
  const fnStart = src.indexOf('async function dispatchTrustedHoverDismiss(', commentStart);
  assert.ok(fnStart > -1, 'dispatchTrustedHoverDismiss function must exist after its comment');
  // Slice to the next function definition or end-of-module. The function
  // ends at the closing `}` before `createEnhancedModeCache` or another
  // top-level declaration. Find the next `function ` or `const ` at column 0
  // after the start.
  const after = src.slice(fnStart);
  const endMatch = after.match(/\n  (?:function |const |\/\/ )/);
  const end = endMatch ? endMatch.index : Math.min(after.length, 3500);
  // Return the comment + function body. Slice from commentStart to fnStart
  // for the comment, then append the function body.
  return src.slice(commentStart, fnStart) + after.slice(0, end);
}

function sliceDispatchTrustedHover(src) {
  const start = src.indexOf('async function dispatchTrustedHover(');
  assert.ok(start > -1, 'dispatchTrustedHover must be defined');
  // Slice up to dispatchTrustedHoverDismiss (the next function in the file).
  const end = src.indexOf('async function dispatchTrustedHoverDismiss(', start);
  assert.ok(end > start, 'dispatchTrustedHover must be sliceable');
  return src.slice(start, end);
}

describe('RC48: dismiss-path mouseMoved timeout must not be tighter than hover path', () => {
  // The 500ms override on hoverDismiss.mouseMoved caused 98% failure in the
  // RC48 incident log. The fix is to remove the override and use the default
  // (2000ms) — matching the hover path. Without this test, future maintainers
  // might re-add a tight "best-effort" timeout and reintroduce the cascade
  // where failed dismisses suppress subsequent hover mounts.

  it('hoverDismiss.mouseMoved does NOT pass a sub-1500ms override to withTimeout', () => {
    const body = sliceDispatchTrustedHoverDismiss(readSrc('lib/renderer-activation.js'));
    // Locate the mouseMoved withTimeout call.
    const labelIdx = body.indexOf("'hoverDismiss.mouseMoved'");
    assert.ok(labelIdx > -1, "hoverDismiss.mouseMoved step label must exist");
    // Look at the 80 chars around the label to find any timeout override arg.
    const around = body.slice(labelIdx, labelIdx + 80);
    // Match `, 500)` or `, 500 ` etc. — any numeric literal < 1500 passed as
    // the third arg. Default-budget usage is just `', 'hoverDismiss.mouseMoved')`
    // with no third arg.
    const tightOverride = around.match(/,\s*(\d{2,4})\s*\)/);
    if (tightOverride) {
      const val = parseInt(tightOverride[1], 10);
      assert.ok(val >= 1500,
        'hoverDismiss.mouseMoved timeout override must be >= 1500ms. ' +
        'RC48 incident showed 500ms caused 98% dismiss failure (58/59 events in ' +
        'docs/console.log 2026-08-13). Got: ' + val + 'ms.');
    }
    // If no override present, the default CDP_STEP_TIMEOUT_MS (2000ms) applies — OK.
  });

  it('hoverDismiss.attach is NOT given a sub-1500ms override (matches hover path default)', () => {
    // The attach step already used the default in RC48-pre source, but defend
    // against future regressions where someone might tighten it for symmetry
    // with the (formerly tight) mouseMoved/detach.
    const body = sliceDispatchTrustedHoverDismiss(readSrc('lib/renderer-activation.js'));
    const labelIdx = body.indexOf("'hoverDismiss.attach'");
    assert.ok(labelIdx > -1, "hoverDismiss.attach step label must exist");
    const around = body.slice(labelIdx, labelIdx + 80);
    const tightOverride = around.match(/,\s*(\d{2,4})\s*\)/);
    if (tightOverride) {
      const val = parseInt(tightOverride[1], 10);
      assert.ok(val >= 1500,
        'hoverDismiss.attach timeout must be >= 1500ms. Got: ' + val + 'ms.');
    }
  });

  it('hoverDismiss.detach does NOT use a sub-1500ms override', () => {
    // detach was also overridden to 500ms in RC48-pre. The fix removes that
    // override too — a hung detach would leak the debugger session and cause
    // the next attach to fail with "Another extension is debugging this tab".
    const body = sliceDispatchTrustedHoverDismiss(readSrc('lib/renderer-activation.js'));
    const labelIdx = body.indexOf("'hoverDismiss.detach'");
    assert.ok(labelIdx > -1, "hoverDismiss.detach step label must exist");
    const around = body.slice(labelIdx, labelIdx + 80);
    const tightOverride = around.match(/,\s*(\d{2,4})\s*\)/);
    if (tightOverride) {
      const val = parseInt(tightOverride[1], 10);
      assert.ok(val >= 1500,
        'hoverDismiss.detach timeout must be >= 1500ms. Got: ' + val + 'ms.');
    }
  });
});

describe('RC48: comment documents the empirical failure rate', () => {
  // Without a comment citing the 98% failure rate, future maintainers will
  // see "default timeout for cleanup seems excessive" and reintroduce the
  // 500ms override. The comment must mention the incident data so the
  // empirical evidence is preserved.

  it('dismiss-path comment mentions RC48 incident or the 98% failure rate', () => {
    const body = sliceDispatchTrustedHoverDismiss(readSrc('lib/renderer-activation.js'));
    // Look for RC48 reference OR the failure-rate percentage OR a "do not
    // tighten" warning. Any of these documents the WHY adequately.
    const hasRC48 = /RC48/.test(body);
    const hasFailureRate = /98%|98 ?%|79%/.test(body);
    const hasWarning = /do not tighten|do not lower|don.t tighten|don.t lower/i.test(body);
    assert.ok(hasRC48 || hasFailureRate || hasWarning,
      'dismiss-path comment must document WHY timeouts match the hover path. ' +
      'Reference RC48, the 98% failure rate, or include a "do not tighten" warning.');
  });
});

describe('RC48: universality — no site-specific terms', () => {
  const SITE_NAMES = ['facebook', 'twitter', 'linkedin', 'tiktok', 'reddit',
    'instagram', 'weibo', 'zhihu', 'douyin'];
  const SITE_ABBREV = ['fb', 'ig'];
  const FORBIDDEN = new RegExp(
    '\\b(' + SITE_NAMES.join('|') + ')\\b|\\b(' + SITE_ABBREV.join('|') + ')\\b',
    'gi'
  );

  it('lib/renderer-activation.js dispatchTrustedHoverDismiss body has no site-specific terms', () => {
    const body = sliceDispatchTrustedHoverDismiss(readSrc('lib/renderer-activation.js'));
    const matches = body.match(FORBIDDEN) || [];
    assert.deepEqual(matches, [],
      'dispatchTrustedHoverDismiss body must contain no site-specific terms. ' +
      'Found: ' + JSON.stringify(matches));
  });

  it('this test file has no site-specific prose beyond the universality guard itself', () => {
    const self = fs.readFileSync(__filename, 'utf8');
    const stripped = self
      .replace(/const SITE_NAMES[\s\S]*?;/, '')
      .replace(/const SITE_ABBREV[\s\S]*?;/, '')
      .replace(/const FORBIDDEN[\s\S]*?;/, '');
    const matches = stripped.match(FORBIDDEN) || [];
    assert.deepEqual(matches, [],
      'RC48 test file must not use site-specific terms outside the universality-guard character class. ' +
      'Found: ' + JSON.stringify(matches));
  });
});
