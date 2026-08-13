// RC46 audit: scoring cascade must check source BEFORE posAbsolute.
//
// THIRTEENTH hover-family incident followup. console.log 2026-08-12 (post-RC45)
// showed $extractWithHover returning empty hovercards for every post despite
// CDP mouseMoved successfully triggering portal mounts (addedNodes >= 1 in
// 105/272 iterations). Root cause was in domHover's auto-discovery picker,
// not RC45 itself.
//
// Failure mode (smoking gun from line 2132 of console.log):
//   considered top 3:
//     1. DIV posAbsolute:true  z:0 dist:488 area:365840 source:"efp"   <- PICKED
//     2. DIV posAbsolute:true  z:0 dist:488 area:365840 source:"efp"
//     3. DIV posAbsolute:false z:0 dist:488 area:365840 source:"added" <- ACTUAL HOVERCARD
//
// The cascade at content-script.js sorted: posAbsolute > z > source > dist > area.
// posAbsolute was checked FIRST, so a pre-existing positioned page chrome
// (posAbsolute:true, source:"efp") beat the actual hovercard (posAbsolute:false
// on its visible inner content div, source:"added"). The captured htmlSnippet
// was page chrome; the LLM classifier then dropped it for lacking account/group
// links, producing empty hovercards:[] in every record.
//
// Architectural flaw: posAbsolute is necessary for a hovercard but nowhere near
// sufficient (every page has dozens of pre-existing positioned divs). The ONLY
// signal that uniquely identifies a hovercard-mount event is source:"added"
// (MutationObserver caught the portal being mounted). source must be the
// strongest tiebreaker, checked before posAbsolute.
//
// Source-text audit pattern: domHover runs in the content script where
// chrome.* + page DOM are available, so unit tests cannot exercise it
// directly. Audit by slicing the sort block from the source.

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

function sliceSortBlock(body) {
  const marker = 'passingCandidates.sort';
  const idx = body.indexOf(marker);
  assert.ok(idx > -1, 'passingCandidates.sort must exist in domHover');
  return body.slice(idx, idx + 800);
}

describe('RC46: domHover scoring cascade checks source BEFORE posAbsolute', () => {
  // The fix moves the source comparison above posAbsolute in the sort cascade.
  // Without it, a pre-existing positioned page chrome (posAbsolute:true,
  // source:"efp") beats the actual hovercard (posAbsolute:false on its inner
  // content, source:"added") — even though source:"added" is the only signal
  // that uniquely identifies a portal-mount event.

  it('source comparison appears in the sort cascade before posAbsolute comparison', () => {
    const body = sliceDomHover(readSrc('content-script.js'));
    const sortBlock = sliceSortBlock(body);

    const sourceIdx = sortBlock.indexOf("a.source !== b.source");
    const posAbsIdx = sortBlock.indexOf('a.posAbsolute !== b.posAbsolute');

    assert.ok(sourceIdx > -1, 'sort cascade must compare a.source !== b.source');
    assert.ok(posAbsIdx > -1, 'sort cascade must compare a.posAbsolute !== b.posAbsolute');
    assert.ok(sourceIdx < posAbsIdx,
      'source comparison must appear BEFORE posAbsolute comparison in the sort cascade. ' +
      'RC45 console.log showed posAbsolute-first picking a pre-existing positioned DIV ' +
      '(source:"efp") over the actual hovercard (source:"added") because hovercard inner ' +
      'content has posAbsolute:false while page chrome has posAbsolute:true.');
  });

  it('source:"added" wins over source:"efp" regardless of posAbsolute', () => {
    // Even if the added candidate has posAbsolute:false and the efp candidate
    // has posAbsolute:true, the added one must sort first. This is the exact
    // scenario from the smoking-gun log line.
    const body = sliceDomHover(readSrc('content-script.js'));
    const sortBlock = sliceSortBlock(body);

    // Confirm the source comparison returns -1 for added (i.e. added sorts first)
    assert.ok(/a\.source\s*===\s*['"]added['"]\s*\?\s*-1\s*:\s*1/.test(sortBlock),
      'source comparison must favor "added" (return -1 when a.source === "added")');

    // Confirm it appears BEFORE posAbsolute comparison
    const sourceIdx = sortBlock.indexOf("a.source !== b.source");
    const posAbsIdx = sortBlock.indexOf('a.posAbsolute !== b.posAbsolute');
    assert.ok(sourceIdx < posAbsIdx,
      'source comparison must be the first (or earlier) check so added beats posAbsolute.');
  });

  it('preserves posAbsolute as a tiebreaker between same-source candidates', () => {
    // When both candidates are source:"efp" (pre-existing, no portal mount),
    // posAbsolute should still break ties — favoring positioned overlays over
    // static content. This preserves RC39 (pre-allocated portal: both efp).
    const body = sliceDomHover(readSrc('content-script.js'));
    const sortBlock = sliceSortBlock(body);

    const posAbsIdx = sortBlock.indexOf('a.posAbsolute !== b.posAbsolute');
    const zIdx = sortBlock.indexOf('a.z !== b.z');
    assert.ok(posAbsIdx > -1 && zIdx > -1 && posAbsIdx < zIdx,
      'posAbsolute must remain in the cascade (as a tiebreaker after source), ' +
      'ahead of z-index, so two same-source candidates still resolve by positioning.');
  });

  it('comment block explains WHY source beats posAbsolute', () => {
    // Future maintainers will see posAbsolute-first as "obviously correct" and
    // may reorder. The comment must explain the RC45/RC46 incident so the
    // reordering is preserved.
    const body = sliceDomHover(readSrc('content-script.js'));
    const sortIdx = body.indexOf('passingCandidates.sort');
    // Look at the 600 chars BEFORE the sort call to find the explanatory comment
    const commentBlock = body.slice(Math.max(0, sortIdx - 600), sortIdx);
    assert.ok(/source/i.test(commentBlock),
      'comment above sort cascade must mention "source" so the RC46 reorder is documented.');
    assert.ok(/posAbsolute|position/i.test(commentBlock),
      'comment above sort cascade must mention posAbsolute/positioning so the RC46 reorder is documented.');
  });
});

describe('RC46: universality — no site-specific terms in new test or source', () => {
  // Per CLAUDE.md: framework code and test fixtures must use abstract names
  // (container/record/anchor/hovercard) only. The RC46 fix is pure
  // infrastructure (source-vs-posAbsolute cascade order) and must not
  // introduce any site-specific references.
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
    // The FORBIDDEN regex character class above mentions the terms by name;
    // that is the only allowed occurrence. Verify no other use in this file.
    const self = fs.readFileSync(__filename, 'utf8');
    // Strip the universality-guard block (the SITE_NAMES + SITE_ABBREV arrays
    // and the FORBIDDEN regex built from them).
    const stripped = self
      .replace(/const SITE_NAMES[\s\S]*?;/, '')
      .replace(/const SITE_ABBREV[\s\S]*?;/, '')
      .replace(/const FORBIDDEN[\s\S]*?;/, '');
    const matches = stripped.match(FORBIDDEN) || [];
    assert.deepEqual(matches, [],
      'RC46 test file must not use site-specific terms outside the universality-guard character class. ' +
      'Found: ' + JSON.stringify(matches));
  });
});
