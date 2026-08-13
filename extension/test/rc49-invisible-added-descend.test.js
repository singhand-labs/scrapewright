// RC49 audit: domHover must descend into children of invisible added portal
// wrappers to find the actual hovercard content.
//
// FOLLOWUP to RC48 (post-RC47). console.log 2026-08-13 08:27:43-08:27:52
// showed $extractWithHover still missing hovercards even after RC46/RC47/RC48.
// The dominant failure mode: 82 of 116 null-pick iterations had addedNodes:2
// (portal MOUNTED via MutationObserver), but BOTH added DIVs were rejected
// as `invisible` — 164 invisible rejections across the run. The same iterations
// were sampled multiple times (dwellMs 682, 844, ...) with identical rejections,
// proving the portal stayed mounted but the filter never admitted it.
//
// Root cause: portal-wrapper-mounts-first-then-content-renders is a common
// framework pattern (React Portals, modal-style hovercards). The wrapper DIV
// is invisible (display:none, visibility:hidden, opacity:0, or 0x0). The
// actual hovercard content renders INSIDE the wrapper as a child milliseconds
// later. The candidate filter at content-script.js:2075 calls isElementVisible
// on the wrapper only — it never descends into children. So a fully-rendered
// hovercard gets rejected because its wrapper is invisible.
//
// The user's verbatim hypothesis confirmed this exactly:
// > 应该是渲染完毕的条件判断方面或者兜底重试机制方面不够健全？
//   ("Probably the rendering-complete condition check OR fallback retry
//    mechanism isn't robust enough?")
//
// The rendering IS complete — the hovercard content is visible. But the filter
// checks visibility at the wrong DOM level (wrapper, not content).
//
// Fix: when pushCandidate is called for an added node, check if the node is
// invisible. If so, walk descendants (bounded) and push visible descendants
// to candidatePool with source='added'. The source='added' tag lets them win
// the RC46 cascade over efp-sampled page chrome.
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

describe('RC49: domHover collects visible descendants of invisible added nodes', () => {
  // Without descent, portal-wrapper frameworks produce 100% miss rate when
  // the wrapper is invisible. The helper must exist and be callable.

  it('declares a descendant-collection helper or inline walk for added nodes', () => {
    const body = sliceDomHover(readSrc('content-script.js'));
    // Accept either a named helper (collectVisibleDescendants*) or an inline
    // querySelectorAll('*') walk inside the added-nodes loop. Both shapes
    // surface descendants to the candidate pool.
    const hasNamedHelper = /function\s+collectVisibleDescendants|function\s+\w*[Dd]escend\w*/.test(body);
    const hasInlineWalk = /querySelectorAll\(['"]\*['"]\)/.test(body);
    assert.ok(hasNamedHelper || hasInlineWalk,
      'domHover must declare a descendant-collection helper or inline querySelectorAll("*") walk ' +
      'to surface children of invisible added portal wrappers.');
  });

  it('descendant walk is invoked in the added-nodes push loop', () => {
    // The walk must be triggered FOR added nodes (not efp). Efp samples at
    // the cursor stack directly — no wrapper layer to bypass.
    const body = sliceDomHover(readSrc('content-script.js'));
    // Find the added-nodes loop and verify a walk call nearby.
    const addedLoopIdx = body.indexOf('addedNodes[k]');
    assert.ok(addedLoopIdx > -1, 'added-nodes loop must exist');
    const afterLoop = body.slice(addedLoopIdx, addedLoopIdx + 1200);
    const hasWalkInvocation = /collectVisibleDescendants|descend|querySelectorAll\(['"]\*['"]\)/.test(afterLoop);
    assert.ok(hasWalkInvocation,
      'descendant walk must be invoked in or immediately after the added-nodes push loop ' +
      'so invisible wrappers get walked before the candidate filter runs.');
  });

  it('descendant walk is bounded to prevent pathological pages', () => {
    // Some pages have thousands of descendants per added subtree. Without a
    // cap, the pool grows unbounded and the scoring loop slows the tab.
    const body = sliceDomHover(readSrc('content-script.js'));
    // Accept either: an inline `i < N` numeric cap, or a named MAX_* constant.
    const inlineCap = body.match(/(?:descendants|children|nodes)\.length\s*&&\s*\w+\s*<\s*(\d{2,4})/);
    const constantCap = body.match(/MAX_DESCENDANTS\s*=\s*(\d{2,4})/);
    const cap = inlineCap ? parseInt(inlineCap[1], 10)
               : constantCap ? parseInt(constantCap[1], 10)
               : null;
    assert.ok(cap !== null,
      'descendant walk must be bounded by a numeric cap (inline i < N or named MAX_DESCENDANTS). ' +
      'Without a cap, pathological pages flood the candidate pool.');
    assert.ok(cap >= 20 && cap <= 200,
      'descendant cap must be in [20, 200] — low enough to bound pool growth, ' +
      'high enough to surface typical hovercard subtrees. Got: ' + cap);
  });
});

describe('RC49: comment documents the portal-wrapper pattern', () => {
  // Without a comment citing the failure mode, future maintainers will see
  // "why are we walking descendants of every added node?" and remove the walk
  // as speculative generality. The comment must mention RC49 or the
  // portal-wrapper-mounts-first pattern so the empirical evidence is preserved.

  it('descendant-walk comment mentions RC49 OR portal-wrapper OR invisible', () => {
    const body = sliceDomHover(readSrc('content-script.js'));
    const hasRC49 = /RC49/.test(body);
    const hasPortalWrapper = /portal[- ]wrapper/i.test(body);
    const hasInvisibleWrapper = /invisible[- ]wrapper|wrapper.*invisible|invisible.*added/i.test(body);
    assert.ok(hasRC49 || hasPortalWrapper || hasInvisibleWrapper,
      'descendant-walk comment must document WHY descent is needed. ' +
      'Reference RC49, the portal-wrapper pattern, or invisible-added-wrapper scenario.');
  });
});

describe('RC49: universality — no site-specific terms', () => {
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
      'domHover body must contain no site-specific terms. ' +
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
      'RC49 test file must not use site-specific terms outside the universality-guard character class. ' +
      'Found: ' + JSON.stringify(matches));
  });
});
