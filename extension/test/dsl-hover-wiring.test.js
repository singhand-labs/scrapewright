// Source-text audit for the $hover DSL primitive wiring (relay chain + DSL guide).
//
// The $hover feature spans 4 files:
//   - lib/renderer-activation.js: dispatchTrustedHover + dispatchTrustedHoverDismiss (CDP)
//   - background.js: TRUSTED_HOVER_REQUEST + TRUSTED_HOVER_DISMISS message handlers
//   - content-script.js: domHover helper + 'hover' case in handleDomRequest switch
//   - sandbox.js: window.$hover exposure
//   - lib/wizard-utils.js: SCRIPT_DSL_GUIDE HOVER ENRICHMENT pattern
//
// Tests guard against silent-disable regressions (RC30 part-2 family: the wiring
// existed in source but was never wired in the production browser). Also guards
// universality: no site-specific terms anywhere in the new code or prompt text.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const EXT_DIR = path.join(__dirname, '..');
const readSrc = (rel) => fs.readFileSync(path.join(EXT_DIR, rel), 'utf8');

test('renderer-activation.js: dispatchTrustedHover + dispatchTrustedHoverDismiss exposed', () => {
  const src = readSrc('lib/renderer-activation.js');
  assert.match(src, /async function dispatchTrustedHover\s*\(/, 'should define dispatchTrustedHover');
  assert.match(src, /async function dispatchTrustedHoverDismiss\s*\(/, 'should define dispatchTrustedHoverDismiss');
  // Must be on the api object AND exposed as free variables + RendererActivation.*.
  assert.match(src, /dispatchTrustedHover:\s*dispatchTrustedHover/);
  assert.match(src, /dispatchTrustedHoverDismiss:\s*dispatchTrustedHoverDismiss/);
  assert.match(src, /window\.dispatchTrustedHover\s*=/);
  assert.match(src, /window\.dispatchTrustedHoverDismiss\s*=/);
  assert.match(src, /self\.dispatchTrustedHover\s*=/);
  assert.match(src, /self\.dispatchTrustedHoverDismiss\s*=/);
  assert.match(src, /global\.dispatchTrustedHover\s*=/);
  assert.match(src, /global\.dispatchTrustedHoverDismiss\s*=/);
});

test('renderer-activation.js: dispatchTrustedHover does NOT dispatch mouseWheel', () => {
  // Hover is a stationary mouseMoved. If a future refactor copies the wheel
  // dispatch back in, the primitive would scroll the page on every hover.
  // Scope the assertion to JUST the hover function body to avoid matching the
  // wheel function's mouseWheel block.
  const src = readSrc('lib/renderer-activation.js');
  const hoverStart = src.indexOf('async function dispatchTrustedHover(');
  assert.ok(hoverStart > -1, 'dispatchTrustedHover must exist');
  const hoverEnd = src.indexOf('async function dispatchTrustedHoverDismiss(');
  assert.ok(hoverEnd > hoverStart, 'dispatchTrustedHoverDismiss must follow dispatchTrustedHover');
  const hoverBody = src.slice(hoverStart, hoverEnd);
  assert.ok(!/type:\s*'mouseWheel'/.test(hoverBody),
    'dispatchTrustedHover must NOT send mouseWheel — got: ' + hoverBody.slice(0, 400));
});

test('renderer-activation.js: dispatchTrustedHoverDismiss moves cursor to (1,1)', () => {
  const src = readSrc('lib/renderer-activation.js');
  const dismissStart = src.indexOf('async function dispatchTrustedHoverDismiss(');
  assert.ok(dismissStart > -1);
  // Take through end of file (last function).
  const dismissBody = src.slice(dismissStart);
  assert.match(dismissBody, /x:\s*1,\s*y:\s*1/, 'dismiss should move mouse to (1,1)');
  assert.ok(!/type:\s*'mouseWheel'/.test(dismissBody),
    'dispatchTrustedHoverDismiss must NOT send mouseWheel');
});

test('background.js: TRUSTED_HOVER_REQUEST + TRUSTED_HOVER_DISMISS handlers wired', () => {
  const src = readSrc('background.js');
  assert.match(src, /message\.type === 'TRUSTED_HOVER_REQUEST'/);
  assert.match(src, /message\.type === 'TRUSTED_HOVER_DISMISS'/);
  // Both handlers must invoke the corresponding RendererActivation dispatch.
  assert.match(src, /RendererActivation\.dispatchTrustedHover\s*\(/);
  assert.match(src, /RendererActivation\.dispatchTrustedHoverDismiss\s*\(/);
});

test('content-script.js: domHover defined and wired into handleDomRequest', () => {
  const src = readSrc('content-script.js');
  assert.match(src, /async function domHover\s*\(/, 'should define domHover');
  assert.match(src, /case 'hover':/, "should add 'hover' case to handleDomRequest switch");
  // domHover must use the trusted-hover relay (not a JS-only mouseover fallback).
  assert.match(src, /type:\s*'TRUSTED_HOVER_REQUEST'/, 'domHover must send TRUSTED_HOVER_REQUEST');
  assert.match(src, /type:\s*'TRUSTED_HOVER_DISMISS'/, 'domHover must send TRUSTED_HOVER_DISMISS for cleanup');
  // Must wrap the hover in withTabActivation so frame production fires.
  assert.match(src, /withTabActivation\(\s*['"]hover['"]/, 'domHover must wrap in withTabActivation');
});

test('content-script.js: domHover surfaces hover_request diagnostic', () => {
  // Diagnostic surfacing matches the trusted-wheel relay pattern — content-script
  // emits a hover_request marker that background mirrors into the SW log so
  // debugging works from the background DevTools (where the user captures logs).
  const src = readSrc('content-script.js');
  assert.match(src, /notifyBackgroundDiagnostic\(\s*['"]hover_request['"]/);
  assert.match(src, /notifyBackgroundDiagnostic\(\s*['"]hover_dismiss['"]/);
});

test('sandbox.js: window.$hover exposed with the expected signature', () => {
  const src = readSrc('sandbox.js');
  assert.match(src, /window\.\$hover\s*=\s*\(/, 'should expose window.$hover');
  // Signature: (anchorSel, popoverSel, opts) — sendDomRequest('hover', anchorSel, [popoverSel, opts])
  assert.match(src, /sendDomRequest\(\s*['"]hover['"]\s*,\s*anchorSel\s*,\s*\[\s*popoverSel/);
});

test('wizard-utils.js: SCRIPT_DSL_GUIDE includes HOVER ENRICHMENT pattern', () => {
  const src = readSrc('lib/wizard-utils.js');
  assert.match(src, /HOVER ENRICHMENT/, 'should document HOVER ENRICHMENT in DSL guide');
  // The guide MUST surface the Enhanced Mode requirement (without it, $hover
  // silently returns hovered:false on every call).
  assert.match(src, /Enhanced Mode/i);
  // Must document the return shape so the LLM knows htmlSnippet can be null.
  assert.match(src, /htmlSnippet/);
  // Must recommend $hover over $openTab for hovercard data. In source text the
  // `$` chars are escaped as `\$` (template-literal escape), so the regex
  // matches against the literal `\$hover` / `\$openTab` form.
  assert.match(src, /PREFER \\\$hover over \\\$openTab/);
});

test('universality: no site-specific terms in new hover-related code or prompt text', () => {
  // Universality guard (RC24 family). The $hover feature must be site-agnostic.
  // We check ONLY the hover-specific slices to avoid false positives from
  // pre-existing comments elsewhere in the file (e.g. renderer-activation.js's
  // trusted-wheel comments mention Facebook as historical context — that's
  // not part of the $hover feature).
  const bannedRegex = /\b(facebook|twitter|linkedin|tiktok|reddit|instagram|youtube|weibo|wechat|xiaohongshu|douyin)\b/i;
  const shortBannedRegex = /\b(fb|ig)\b/i;  // stricter — only short forms in CODE, not comments

  const hoverSlices = [];

  // renderer-activation.js: only the dispatchTrustedHover + dispatchTrustedHoverDismiss bodies.
  // Stop at the createEnhancedModeCache COMMENT block to avoid catching the
  // pre-existing RC25 comment that mentions a specific scraping scenario.
  const ra = readSrc('lib/renderer-activation.js');
  const raHoverStart = ra.indexOf('async function dispatchTrustedHover(');
  const raHoverEnd = ra.indexOf('// createEnhancedModeCache', raHoverStart);
  hoverSlices.push({
    name: 'renderer-activation.js (dispatchTrustedHover + dismiss bodies)',
    src: ra.slice(raHoverStart, raHoverEnd),
  });

  // background.js: only the TRUSTED_HOVER_REQUEST + _DISMISS handler bodies.
  const bg = readSrc('background.js');
  const bgStart = bg.indexOf("message.type === 'TRUSTED_HOVER_REQUEST'");
  const bgEnd = bg.indexOf("if (message.type === 'GET_ENHANCED_MODE_STATE'", bgStart);
  hoverSlices.push({ name: 'background.js (TRUSTED_HOVER_* handlers)', src: bg.slice(bgStart, bgEnd) });

  // content-script.js: domHover body + case 'hover' body.
  const cs = readSrc('content-script.js');
  const csFnStart = cs.indexOf('async function domHover(');
  const csFnEnd = cs.indexOf('async function domOpenTab(', csFnStart);
  hoverSlices.push({ name: 'content-script.js (domHover)', src: cs.slice(csFnStart, csFnEnd) });

  // sandbox.js: only the window.$hover line.
  const sandbox = readSrc('sandbox.js');
  const sbStart = sandbox.indexOf('window.$hover');
  const sbEnd = sandbox.indexOf('\n', sbStart);
  hoverSlices.push({ name: 'sandbox.js ($hover line)', src: sandbox.slice(sbStart, sbEnd) });

  // wizard-utils.js: HOVER ENRICHMENT section.
  const wu = readSrc('lib/wizard-utils.js');
  const wuStart = wu.indexOf('HOVER ENRICHMENT');
  const wuEnd = wu.indexOf('ROBUSTNESS RULES', wuStart);
  hoverSlices.push({ name: 'wizard-utils.js (HOVER ENRICHMENT section)', src: wu.slice(wuStart, wuEnd) });

  for (const slice of hoverSlices) {
    const m = slice.src.match(bannedRegex);
    assert.ok(!m, `${slice.name} must not contain site names; found: ${m && m[0]}`);
    // Short forms only flagged in code-like regions (no spaces around) — they're
    // common in comments as abbreviations ('fb' as 'feedback', 'ig' as 'ignore').
    // Tighten: require word-boundary match AND short form letter-run to avoid
    // false positives.
    const lower = slice.src.toLowerCase();
    assert.ok(!/\bfb\b/.test(lower), `${slice.name} must not contain standalone 'fb'`);
    assert.ok(!/\big\b/.test(lower), `${slice.name} must not contain standalone 'ig'`);
  }
});

test('sandbox.js, content-script.js, background.js: hover wiring is non-empty (regression guard)', () => {
  // RC30 part-2 lesson: source-text audits that only check for the EXISTENCE
  // of a substring can pass against stubs. Add a minimum-content check: the
  // hover case in content-script.js must actually call domHover (not just
  // declare it), and domHover must do meaningful work.
  const cs = readSrc('content-script.js');
  assert.match(cs, /case 'hover':\s*\{[^}]*domHover\(/,
    "case 'hover' must call domHover in its body");
  assert.match(cs, /async function domHover\([^)]*\)\s*\{[\s\S]{200,}\}/,
    'domHover must have a non-trivial body (>200 chars)');
});

test('$hover primitive name is consistent across all 4 files', () => {
  // LLM-facing name: $hover. Internal action: 'hover'. Message types:
  // TRUSTED_HOVER_REQUEST / TRUSTED_HOVER_DISMISS. Function names:
  // dispatchTrustedHover / dispatchTrustedHoverDismiss / domHover.
  // A typo in any one file silently breaks the chain.
  const sandboxSrc = readSrc('sandbox.js');
  assert.match(sandboxSrc, /\$hover/);
  const csSrc = readSrc('content-script.js');
  assert.match(csSrc, /case 'hover'/);
  assert.match(csSrc, /async function domHover/);
  const bgSrc = readSrc('background.js');
  assert.match(bgSrc, /TRUSTED_HOVER_REQUEST/);
  assert.match(bgSrc, /TRUSTED_HOVER_DISMISS/);
  assert.match(bgSrc, /dispatchTrustedHover\b/);
  assert.match(bgSrc, /dispatchTrustedHoverDismiss\b/);
  const raSrc = readSrc('lib/renderer-activation.js');
  assert.match(raSrc, /async function dispatchTrustedHover\b/);
  assert.match(raSrc, /async function dispatchTrustedHoverDismiss\b/);
});

test('domHover supports opts.index for multi-record addressing (RC34)', () => {
  // console.log 2026-08-11: LLM tried to hover the Nth anchor in a list using
  // `:nth-of-type(${i+1})` — the CSS TRAP already documented at line 50 of
  // SCRIPT_DSL_GUIDE. The trap silently matches the Nth sibling OF THE SAME
  // TAG, not the Nth compound-selector match, so iter>0 picks the wrong
  // anchor (or none). The fix: $hover accepts opts.index and uses
  // querySelectorAllDeep to pick the Nth match — same addressing semantics
  // as $list()[N] but without the round-trip.
  const cs = readSrc('content-script.js');
  const fnStart = cs.indexOf('async function domHover(');
  const fnEnd = cs.indexOf('async function domOpenTab(', fnStart);
  const fnBody = cs.slice(fnStart, fnEnd);
  assert.ok(fnStart > -1 && fnEnd > fnStart, 'domHover must exist');
  // Must read opts.index
  assert.match(fnBody, /opts\.index/, 'domHover must read opts.index');
  // When opts.index is set, must use querySelectorAllDeep (not querySelectorDeep)
  // to enumerate all matches and pick the Nth.
  assert.match(fnBody, /querySelectorAllDeep/, 'domHover must use querySelectorAllDeep for opts.index');
  // Must throw a clear error when index is out of range (so autoFix can react),
  // not silently fall back to the first match.
  assert.match(fnBody, /INDEX_OUT_OF_RANGE|out of range/i,
    'domHover must surface an out-of-range index error');
});

test('HOVER ENRICHMENT guide teaches opts.index (NOT :nth-of-type) for multi-record hover', () => {
  // The pre-fix example used `li.result-item:nth-of-type(1) a.profile-link`,
  // which is the exact CSS TRAP that caused the production failure. The guide
  // must now teach opts.index for multi-record addressing and explicitly
  // cross-reference the :nth-of-type trap.
  const wu = readSrc('lib/wizard-utils.js');
  // Slice from the SECTION HEADER (not the inline "See HOVER ENRICHMENT below"
  // mention in the signature line). The header is the long-form variant.
  const sectionStart = wu.indexOf('HOVER ENRICHMENT (hovercard');
  const sectionEnd = wu.indexOf('ROBUSTNESS RULES', sectionStart);
  const section = wu.slice(sectionStart, sectionEnd);
  assert.ok(sectionStart > -1 && sectionEnd > sectionStart, 'HOVER ENRICHMENT section must exist');
  // Must document opts.index as the multi-record addressing mechanism.
  assert.match(section, /opts\.index|index:\s*\d/i,
    'HOVER ENRICHMENT must document opts.index for multi-record addressing');
  // Must NOT demonstrate :nth-of-type(N) as the addressing mechanism in code
  // samples. The CSS TRAP anti-pattern block at the top of the file (outside
  // this slice) legitimately shows the WRONG pattern for teaching — that's
  // fine. Inside HOVER ENRICHMENT, only WARNING references are allowed
  // (lines that contain 'trap', 'wrong', 'do not', 'never', etc.).
  const codeLines = section.split('\n').filter(l => /:nth-of-type\(\s*\\?\$?\{?/i.test(l) || /:nth-of-type\(\d+/i.test(l));
  for (const line of codeLines) {
    const isWarning = /trap|wrong|do not|never|anti-pattern|forbidden/i.test(line);
    assert.ok(isWarning,
      `HOVER ENRICHMENT must not demonstrate :nth-of-type in code; found: ${line.trim()}`);
  }
});

test('domHover auto-discovers portal popovers when popoverSel fails (RC34 followup)', () => {
  // console.log 2026-08-11: LLM-provided popoverSel 'div[data-hovercard],
  // div[role=dialog]' never matched the site's actual portal container, so
  // htmlSnippet stayed null on every iteration even though the hover did fire.
  // The fix: when popoverSel doesn't match within timeout, fall back to
  // auto-discovery — observe DOM mutations during the hover window, and if any
  // new visible element of non-trivial size appears, treat it as the popover.
  // Universal: works for React Portal / Vue Teleport / Popper / Floating UI —
  // any popover implementation that adds a new element to the DOM.
  const cs = readSrc('content-script.js');
  const fnStart = cs.indexOf('async function domHover(');
  const fnEnd = cs.indexOf('async function domOpenTab(', fnStart);
  const fnBody = cs.slice(fnStart, fnEnd);
  assert.ok(fnStart > -1 && fnEnd > fnStart, 'domHover must exist');
  // Must use MutationObserver to track added nodes during the hover window.
  assert.match(fnBody, /MutationObserver/, 'domHover must use MutationObserver for auto-discovery');
  // Must observe document.body subtree (portals render at body level).
  assert.match(fnBody, /subtree:\s*true/, 'observer must track subtree');
  // Must filter out tiny additions (analytics pixels, etc.) by size.
  assert.match(fnBody, /getBoundingClientRect/,
    'auto-discovery must size-filter candidates to avoid analytics noise');
  // Result must surface autoDiscovered flag so the LLM knows we fell back.
  assert.match(fnBody, /autoDiscovered/,
    'domHover result must surface autoDiscovered flag');
});

test('domHover sets up MutationObserver BEFORE hover dispatch (RC36 observer race)', () => {
  // console.log 2026-08-11 13:14+: when the LLM picks the wrong popoverSel
  // (e.g. a link-preview tooltip selector instead of a hovercard container),
  // path (a) explicit-match misses. Path (b) auto-discovery MUST catch the
  // popover via MutationObserver — but only if the observer was set up
  // BEFORE the page's hover handler fired. If observer setup happens AFTER
  // the hover dispatch await, the page handler has already added the popover
  // by the time .observe() starts, and observer never sees the addition
  // (MutationObserver doesn't fire for past mutations).
  //
  // Production symptom: htmlSnippet:null across all iterations even though
  // hover_request logs dispatched:true/ok:true. The hovercard WAS rendered,
  // we just missed it.
  //
  // This test pins the order: `new MutationObserver` must appear BEFORE
  // the TRUSTED_HOVER_REQUEST sendMessage in the function body.
  const cs = readSrc('content-script.js');
  const fnStart = cs.indexOf('async function domHover(');
  const fnEnd = cs.indexOf('async function domOpenTab(', fnStart);
  const fnBody = cs.slice(fnStart, fnEnd);
  assert.ok(fnStart > -1 && fnEnd > fnStart, 'domHover must exist');

  const observerSetupPos = fnBody.indexOf('new MutationObserver');
  const hoverDispatchPos = fnBody.indexOf('TRUSTED_HOVER_REQUEST');
  assert.ok(observerSetupPos > -1, 'domHover must create a MutationObserver');
  assert.ok(hoverDispatchPos > -1, 'domHover must dispatch TRUSTED_HOVER_REQUEST');
  assert.ok(
    observerSetupPos < hoverDispatchPos,
    'MutationObserver must be set up BEFORE hover dispatch (currently observer starts after dispatch returns, missing popovers added during the CDP roundtrip). ' +
    'observerSetupPos=' + observerSetupPos + ' hoverDispatchPos=' + hoverDispatchPos
  );
});

test('domHover auto-discovery scores candidates by multiple signals including cursor proximity (RC38 over-filter architecture fix)', () => {
  // console.log 2026-08-11 15:14: SIXTH hover-family incident. Even after
  // RC37 added the position+z-index hard filter, hover enrichment returned
  // empty fields across all posts. User feedback was unambiguous: "the
  // hovercard IS popping up visually" but htmlSnippet stayed empty. Every
  // hover_request showed dispatched:true ok:true, but path (a) explicit
  // selector missed (LLM picked div[role='dialog']/div[data-hovercard]
  // instead of the working div[data-visualcompletion='ignore-dynamic']),
  // and path (b) auto-discovery SILENTLY rejected the real hovercard.
  //
  // Why the RC37 hard filter failed: overlay frameworks don't always set
  // position:absolute AND numeric z-index on the popover element itself.
  // Common cases the RC37 filter silently rejected:
  //   - Hovercard has position:absolute but z-index:auto (stacking context
  //     managed by parent wrapper — common in React Portal + CSS Modules)
  //   - Hovercard wrapper has position:static, inner hovercard has the
  //     positioning (MutationObserver sees the wrapper, not the inner)
  //   - Site uses relative positioning + transform-style overlays
  //
  // Architecture fix: replace the hard filter with multi-signal SCORING.
  // Every candidate (visible, >50x50) is scored; the highest score wins.
  // Signals (strongest first):
  //   1. position absolute/fixed (overlay positioning — primary signal)
  //   2. numeric z-index (creates stacking context)
  //   3. proximity to cursor (hovercards appear AT/NEAR the anchor — the
  //      NEW signal that breaks ties between positioned overlays)
  //   4. area (larger wins on full ties)
  //
  // Why proximity: the hover cursor (anchor bounding-box center) is the
  // universal reference point. Hovercards appear within ~100px of this
  // point regardless of framework. Gradient placeholders and video
  // scaffolding are typically 200-500px away (in post body, not header).
  // Proximity breaks ties the position+z-index signals can't.
  //
  // This test pins the architectural shift: hard filters are fragile
  // (RC37 was the 4th attempt), scoring is robust. Must read .position
  // AND .zIndex AND compute cursor distance.
  const cs = readSrc('content-script.js');
  const fnStart = cs.indexOf('async function domHover(');
  const fnEnd = cs.indexOf('async function domOpenTab(', fnStart);
  const fnBody = cs.slice(fnStart, fnEnd);
  assert.ok(fnStart > -1 && fnEnd > fnStart, 'domHover must exist');

  // Slice the auto-discovery loop region. Isolates from unrelated
  // getComputedStyle calls elsewhere in the function (e.g. isElementVisible).
  const autoDiscoverStart = fnBody.indexOf('Path (b): auto-discovery');
  const autoDiscoverEnd = fnBody.indexOf('observer.disconnect()', autoDiscoverStart);
  assert.ok(autoDiscoverStart > -1, 'auto-discovery comment block must exist');
  assert.ok(autoDiscoverEnd > autoDiscoverStart, 'auto-discovery loop must end before observer.disconnect');
  const loopBody = fnBody.slice(autoDiscoverStart, autoDiscoverEnd);

  // Signal 1: getComputedStyle must be called.
  assert.match(loopBody, /getComputedStyle/,
    'auto-discovery must call getComputedStyle to read stacking signals');

  // Signal 2: .position must be read.
  assert.match(loopBody, /\.position\b/,
    'auto-discovery must read computed style .position (positioned-overlays signal)');

  // Signal 3: .zIndex must be read (as a scoring input, not a hard filter).
  assert.match(loopBody, /\.zIndex\b/,
    'auto-discovery must read computed style .zIndex (stacking-context signal)');

  // Signal 4 (NEW): cursor proximity must be computed. The hover x/y
  // coordinates are the universal reference point — hovercards appear
  // near the cursor regardless of framework. Look for distance computation
  // (sqrt, dx/dy, or rect-vs-cursor comparison).
  assert.match(loopBody, /dist|distance|proximity|dx\s*=|dy\s*=|Math\.(sqrt|hypot)|cursorDist/i,
    'auto-discovery must compute cursor proximity (NEW signal — breaks ties that position/z-index alone cannot). ' +
    'Look for: distance from added-node rect to hover x/y coordinates.');
});

test('domHover auto-discovery emits hover_auto_discover diagnostic (RC38 observability)', () => {
  // RC37/RC38 lesson: auto-discovery failures are SILENT. The user sees
  // empty hover-enriched fields; the log shows dispatched:true ok:true;
  // but no signal explains WHY path (b) rejected the hovercard. We need
  // a diagnostic that surfaces:
  //   - how many nodes the observer caught
  //   - which one was picked (or null)
  //   - its position/z-index/area/proximity
  //
  // This pins the diagnostic emission so future hover-family bugs are
  // debuggable from the SW log alone.
  const cs = readSrc('content-script.js');
  const fnStart = cs.indexOf('async function domHover(');
  const fnEnd = cs.indexOf('async function domOpenTab(', fnStart);
  const fnBody = cs.slice(fnStart, fnEnd);
  assert.ok(fnStart > -1 && fnEnd > fnStart, 'domHover must exist');

  assert.match(fnBody, /notifyBackgroundDiagnostic\(\s*['"]hover_auto_discover['"]/,
    'domHover must emit hover_auto_discover diagnostic via notifyBackgroundDiagnostic ' +
    '(goes to background SW log, not just page console — observability for future hover bugs)');
});

test('domHover auto-discovery samples elementsFromPoint as a secondary candidate source (RC39 pre-existing overlay architecture fix)', () => {
  // console.log 2026-08-12 02:04+: SEVENTH hover-family incident. Even
  // after RC38 added multi-signal scoring (replacing RC37's hard filter),
  // every hover iteration still returned picked:null. The diagnostic
  // repeatedly showed `addedNodes:3, picked:null, reason:"no candidate
  // passed visibility+size+positioning filter"` across all 5 anchors ×
  // multiple iterations.
  //
  // Why scoring alone is INSUFFICIENT: MutationObserver has a fundamental
  // blind spot. It only catches DOM ADDITIONS. Overlay frameworks that
  // PRE-ALLOCATE the portal container at page load and show the hovercard
  // via CSS (display:none → display:block, visibility:hidden → visible)
  // produce ZERO addedNodes during hover. The observer simply cannot see
  // these hovercards, no matter how good the scoring is.
  //
  // Architecture fix: add document.elementsFromPoint sampling as a
  // SECONDARY candidate source. elementsFromPoint returns the stack of
  // elements at a given viewport coordinate, topmost first. It catches
  // overlays regardless of HOW they were shown (new node vs CSS toggle).
  //
  // Sample at cursor AND offset points (above/below/left/right of anchor
  // center) to catch hovercards that appear BESIDE the anchor rather than
  // overlapping it. Combine elementsFromPoint candidates with
  // MutationObserver additions into a unified scoring pool.
  //
  // This is a fundamentally different detection mechanism: MutationObserver
  // observes CHANGES, elementsFromPoint observes STATE. Both are needed
  // because overlay frameworks split into two camps (mutate-on-show vs
  // pre-allocate-and-toggle).
  const cs = readSrc('content-script.js');
  const fnStart = cs.indexOf('async function domHover(');
  const fnEnd = cs.indexOf('async function domOpenTab(', fnStart);
  const fnBody = cs.slice(fnStart, fnEnd);
  assert.ok(fnStart > -1 && fnEnd > fnStart, 'domHover must exist');

  // Slice the auto-discovery region (same RC38 marker pair).
  const autoDiscoverStart = fnBody.indexOf('Path (b): auto-discovery');
  const autoDiscoverEnd = fnBody.indexOf('observer.disconnect()', autoDiscoverStart);
  assert.ok(autoDiscoverStart > -1, 'auto-discovery comment block must exist');
  assert.ok(autoDiscoverEnd > autoDiscoverStart, 'auto-discovery region must end before observer.disconnect');
  const region = fnBody.slice(autoDiscoverStart, autoDiscoverEnd);

  // elementsFromPoint must be invoked in the auto-discovery region.
  assert.match(region, /elementsFromPoint/,
    'auto-discovery must call document.elementsFromPoint to sample pre-existing overlays ' +
    '(MutationObserver alone cannot catch hovercards shown via CSS toggle from a pre-allocated container)');

  // Sampling at multiple offset points (not just the cursor itself) is
  // required to catch hovercards that appear beside the anchor. Look for
  // either: an offsets array literal with >=3 points, OR multiple
  // elementsFromPoint calls, OR a loop over sampling coordinates.
  const hasOffsetsArray = /\[\s*\[\s*0\s*,\s*0\s*\]\s*,/.test(region) ||
                          /\[\s*\[\s*-\d+\s*,\s*0\s*\]/.test(region) ||
                          /\[\s*\[\s*0\s*,\s*-?\d+\s*\]/.test(region);
  const hasMultipleSampling = (region.match(/elementsFromPoint/g) || []).length >= 2;
  const hasLoopSampling = /for\s*\(.*offset|offsets\s*\[|sampleOffsets|samplePoints/.test(region);
  assert.ok(hasOffsetsArray || hasMultipleSampling || hasLoopSampling,
    'auto-discovery must sample elementsFromPoint at multiple coordinates (cursor + offsets) ' +
    'so hovercards appearing beside the anchor are caught');
});

test('domHover auto-discovery diagnostic emits per-candidate rejection details (RC39 observability enhancement)', () => {
  // RC39 lesson: the RC38 diagnostic surfaced `addedNodes:3, picked:null`
  // but gave NO signal to distinguish between two competing hypotheses:
  //   (A) hovercard WAS in addedNodes but rejected by some filter
  //       (need to know WHICH filter — size, position, proximity?)
  //   (B) hovercard was NOT in addedNodes at all (pre-existing overlay
  //       shown via CSS toggle — observer can never catch it)
  //
  // Without per-candidate rejection detail, debugging requires the user
  // to capture a separate page-console log (the page-only sendDebugLog
  // doesn't reach the SW log). This is the same observability gap that
  // made RC37/RC38 debugging take multiple round-trips.
  //
  // Fix: when no candidate passes, emit a rejected[] array with per-node
  // properties: tag, size, position, proximity, reject reason. Cap the
  // array length to keep the diagnostic payload bounded (e.g. <=5).
  const cs = readSrc('content-script.js');
  const fnStart = cs.indexOf('async function domHover(');
  const fnEnd = cs.indexOf('async function domOpenTab(', fnStart);
  const fnBody = cs.slice(fnStart, fnEnd);
  assert.ok(fnStart > -1 && fnEnd > fnStart, 'domHover must exist');

  // Slice the auto-discovery region (same RC38 marker pair).
  const autoDiscoverStart = fnBody.indexOf('Path (b): auto-discovery');
  const autoDiscoverEnd = fnBody.indexOf('observer.disconnect()', autoDiscoverStart);
  assert.ok(autoDiscoverStart > -1 && autoDiscoverEnd > autoDiscoverStart,
    'auto-discovery region must be sliceable');
  const region = fnBody.slice(autoDiscoverStart, autoDiscoverEnd);

  // Per-candidate rejection logging: look for a rejected-array push or
  // a rejectedSummary-like accumulator with per-node fields.
  const hasRejectedAccumulator = /rejectedSummary|rejectedList|rejected\s*:\s*\[|rejected\.push/.test(region);
  const hasRejectReason = /reason:\s*['"]?(too_small|invisible|static_and_far|no_computed_style|size|position|proximity)/i.test(region);
  assert.ok(hasRejectedAccumulator && hasRejectReason,
    'auto-discovery must accumulate per-candidate rejection details ' +
    '(tag/size/position/proximity + reject reason) into the hover_auto_discover diagnostic ' +
    'so future hover-family bugs are debuggable from the SW log alone');
});

test('domHover auto-discovery rejects viewport-sized candidates (RC40 backdrop filter)', () => {
  // console.log 2026-08-12 03:59+: EIGHTH hover-family incident. RC39 added
  // elementsFromPoint sampling (pool:186-211 candidates) — a HUGE improvement
  // over RC38's empty pool. But the picked candidate was consistently a
  // viewport-sized element: area:1,644,015 px² (~80% of a 1920×1080 viewport),
  // posAbsolute:true, z:0, dist:7-78.
  //
  // The result confirmed this is a backdrop/wrapper, NOT a hovercard:
  // accountInfoHtml = "<div class=\"x1ey2m1c xtijo5x x1o0tod xixxii4
  // x13vifvy x1h0vfkc\"></div>" — an empty positioned div. Its CSS classes
  // apply position:absolute; inset:0; making it cover the viewport while
  // remaining empty (a click-capture layer or a placeholder container for a
  // yet-to-render hovercard).
  //
  // Why the RC38/RC39 scoring picked it: the cascade is posAbsolute → z →
  // dist → area (larger wins). The backdrop ties with the real hovercard on
  // posAbsolute (both true) and z (both 0/auto), beats it on dist (viewport
  // center is near cursor), and CRUSHES it on area (1.6M vs ~100K px²).
  //
  // Universal signal: hovercards are bounded UI elements meant to be
  // unobtrusive overlays. They are ALWAYS smaller than the viewport.
  // Backdrops, modal screens, and portal-container pre-allocation layers
  // are viewport-sized or near-viewport-sized. The 50% viewport-area
  // threshold cleanly separates these populations across every overlay
  // framework (portal implementations, modal libraries, site-specific
  // Layer architectures).
  //
  // This is a hard filter, not a scoring change. Hard filters have been
  // fragile before (RC37), but this filter rests on a UNIVERSAL property
  // of hovercards (size bounded by viewport) rather than a framework
  // specific property (z-index value, position value).
  const cs = readSrc('content-script.js');
  const fnStart = cs.indexOf('async function domHover(');
  const fnEnd = cs.indexOf('async function domOpenTab(', fnStart);
  const fnBody = cs.slice(fnStart, fnEnd);
  assert.ok(fnStart > -1 && fnEnd > fnStart, 'domHover must exist');

  const autoDiscoverStart = fnBody.indexOf('Path (b): auto-discovery');
  const autoDiscoverEnd = fnBody.indexOf('observer.disconnect()', autoDiscoverStart);
  assert.ok(autoDiscoverStart > -1 && autoDiscoverEnd > autoDiscoverStart,
    'auto-discovery region must be sliceable');
  const region = fnBody.slice(autoDiscoverStart, autoDiscoverEnd);

  // Must compare candidate area against viewport area (universal hovercard
  // bound). Look for: innerWidth*innerHeight, viewportArea, or a 0.5/50%
  // threshold comparison.
  const hasViewportArea = /innerWidth\s*\*\s*innerHeight|viewportArea|viewport_area/.test(region);
  const hasViewportThreshold = /viewport_sized|viewport.*0\.\d|0\.5\s*\*\s*viewport|viewport.*half/i.test(region);
  assert.ok(hasViewportArea && hasViewportThreshold,
    'auto-discovery must reject viewport-sized candidates (area > ~50% of viewport). ' +
    'Hovercards are always smaller than the viewport; backdrops/wrappers are viewport-sized. ' +
    'Look for: window.innerWidth * window.innerHeight comparison with threshold.');
});

test('domHover auto-discovery diagnostic emits top-N considered candidates always (RC40 observability)', () => {
  // RC40 lesson: the RC39 diagnostic emitted per-candidate rejection details
  // ONLY when picked was null. When picked was non-null (the WRONG pick —
  // viewport-sized backdrop), the diagnostic showed only the picked element's
  // properties with NO visibility into what else was in the pool.
  //
  // Without top-N visibility, we couldn't answer: "was the real hovercard in
  // the pool and lost to the backdrop on area, or was it not in the pool at
  // all?" That question is critical for forming the next hypothesis.
  //
  // Fix: always emit a considered[] array showing the top-N candidates by
  // score, regardless of whether picked is null. Each entry includes the
  // score-relevant fields (tag, posAbsolute, z, dist, area) so the scoring
  // decision can be audited from the SW log alone.
  const cs = readSrc('content-script.js');
  const fnStart = cs.indexOf('async function domHover(');
  const fnEnd = cs.indexOf('async function domOpenTab(', fnStart);
  const fnBody = cs.slice(fnStart, fnEnd);
  assert.ok(fnStart > -1 && fnEnd > fnStart, 'domHover must exist');

  const autoDiscoverStart = fnBody.indexOf('Path (b): auto-discovery');
  const autoDiscoverEnd = fnBody.indexOf('observer.disconnect()', autoDiscoverStart);
  assert.ok(autoDiscoverStart > -1 && autoDiscoverEnd > autoDiscoverStart,
    'auto-discovery region must be sliceable');
  const region = fnBody.slice(autoDiscoverStart, autoDiscoverEnd);

  // Look for a considered/topCandidates accumulator that's emitted in the
  // diagnostic regardless of picked value.
  const hasConsideredAccumulator = /considered|topCandidates|topCandidates\s*=\s*\[|consideredCandidates/.test(region);
  assert.ok(hasConsideredAccumulator,
    'auto-discovery must emit a considered[]/topCandidates[] array in the hover_auto_discover ' +
    'diagnostic ALWAYS (not just when picked is null), so the scoring decision is auditable ' +
    'from the SW log without needing a separate page-console capture.');
});

test('domHover auto-discovery gated by min dwell time before scoring pre-existing pool (RC41 dwell gate)', () => {
  // NINTH hover-family incident (console.log 2026-08-12). Even after RC38-RC40
  // scoring improvements, the picked candidate was consistently wrong:
  // dist:239-489, area:49629-463760, never the actual hovercard.
  //
  // Root cause: auto-discovery picked "best of pool" on the FIRST 250ms tick
  // (T=0). At T=0, MutationObserver had addedNodes:0 (hovercard hadn't mounted
  // yet) and elementsFromPoint returned 77-113 pre-existing positioned DIVs
  // (post wrappers, content sections). The scoring cascade picked the most
  // overlay-looking noise; the loop broke before the actual hovercard appeared
  // (T=500ms+).
  //
  // Architectural fix: gate auto-discovery behind a minimum dwell time. Path
  // (a) popoverSel is exempt (explicit selectors should be honored immediately).
  // The gate lets the loop sleep through the pre-hover window so when
  // auto-discover DOES run, the hovercard has had time to mount and compete
  // in the scoring cascade.
  const cs = readSrc('content-script.js');
  const fnStart = cs.indexOf('async function domHover(');
  const fnEnd = cs.indexOf('async function domOpenTab(', fnStart);
  const fnBody = cs.slice(fnStart, fnEnd);
  assert.ok(fnStart > -1 && fnEnd > fnStart, 'domHover must exist');

  // Look for a min-dwell constant + gate check inside the polling loop.
  const hasMinDwellConstant = /MIN_AUTO_DISCOVER_DWELL_MS|MIN_DWELL_MS|MIN_HOVER_DWELL_MS/.test(fnBody);
  const hasDwellGate = /dwellMs\s*<\s*(?:MIN_AUTO_DISCOVER_DWELL_MS|MIN_DWELL_MS|MIN_HOVER_DWELL_MS)/.test(fnBody);
  assert.ok(hasMinDwellConstant && hasDwellGate,
    'auto-discovery must be gated behind a minimum dwell time (MIN_AUTO_DISCOVER_DWELL_MS or similar). ' +
    'Without the gate, the loop picks pre-existing pool noise on the first 250ms tick before the ' +
    'hovercard has time to mount (~500ms portal delay).');
});

test('domHover auto-discovery applies UNIVERSAL distance cap regardless of position (RC41 distance filter)', () => {
  // NINTH incident: prior filter only rejected STATIC+far elements
  // (`!posAbsolute && dist > 300`). PosAbsolute candidates had NO distance
  // filter, so positioned post-wrappers 400-500px from cursor won the cascade
  // (tied on posAbsolute+z, lost on dist to actual hovercard but won on area).
  //
  // Universal UX property: hovercards ALWAYS appear within ~300-400px of the
  // anchor (cursor center). A candidate > 400px away is definitively not the
  // hovercard regardless of positioning. The cap must apply to ALL candidates.
  const cs = readSrc('content-script.js');
  const fnStart = cs.indexOf('async function domHover(');
  const fnEnd = cs.indexOf('async function domOpenTab(', fnStart);
  const fnBody = cs.slice(fnStart, fnEnd);
  assert.ok(fnStart > -1 && fnEnd > fnStart, 'domHover must exist');

  const autoDiscoverStart = fnBody.indexOf('Path (b): auto-discovery');
  const autoDiscoverEnd = fnBody.indexOf('observer.disconnect()', autoDiscoverStart);
  assert.ok(autoDiscoverStart > -1 && autoDiscoverEnd > autoDiscoverStart,
    'auto-discovery region must be sliceable');
  const region = fnBody.slice(autoDiscoverStart, autoDiscoverEnd);

  // Universal distance cap: dist > N (NOT conditioned on !posAbsolute).
  // Reject reason should be distance-flavored.
  const hasUniversalDistanceCap = /if\s*\(\s*(?:ndist|dist)\s*>\s*\d{2,3}\s*\)/.test(region);
  const hasTooFarReason = /too_far_from_cursor|too_far|dist_max_exceeded/i.test(region);
  assert.ok(hasUniversalDistanceCap && hasTooFarReason,
    'auto-discovery must apply a UNIVERSAL distance cap (reject dist > N regardless of position). ' +
    'The prior `!posAbsolute && dist > 300` filter only caught static+far elements; absolute-positioned ' +
    'wrappers 400-500px from cursor won the cascade. Look for: unconditional distance check with ' +
    'too_far_from_cursor reject reason.');
});

test('domHover auto-discovery tags candidates by source and prefers added over efp (RC41 source priority)', () => {
  // NINTH incident diagnostic showed addedNodes:0 for most iterations but
  // addedNodes:1-2 for a few late iterations. When addedNodes > 0, the new
  // element SHOULD have been the hovercard — but it lost the scoring cascade
  // to larger pre-existing positioned DIVs. The diagnostic didn't even tell
  // us WHICH candidate was the added one vs an efp sample, so we couldn't
  // confirm whether the hovercard was in the pool at all.
  //
  // Fix: tag each candidate with source ('added' from MutationObserver vs
  // 'efp' from elementsFromPoint). Source becomes a tiebreaker in the scoring
  // cascade — 'added' wins ties because it's the strongest hovercard signal
  // (universal across portal frameworks: hovercards mount via React Portal /
  // Vue Teleport / Popper / Floating UI / Tippy, all trigger addedNodes).
  const cs = readSrc('content-script.js');
  const fnStart = cs.indexOf('async function domHover(');
  const fnEnd = cs.indexOf('async function domOpenTab(', fnStart);
  const fnBody = cs.slice(fnStart, fnEnd);
  assert.ok(fnStart > -1 && fnEnd > fnStart, 'domHover must exist');

  const autoDiscoverStart = fnBody.indexOf('Path (b): auto-discovery');
  const autoDiscoverEnd = fnBody.indexOf('observer.disconnect()', autoDiscoverStart);
  assert.ok(autoDiscoverStart > -1 && autoDiscoverEnd > autoDiscoverStart,
    'auto-discovery region must be sliceable');
  const region = fnBody.slice(autoDiscoverStart, autoDiscoverEnd);

  // Source tracking: pushCandidate takes a source arg ('added' or 'efp').
  const hasSourceArg = /pushCandidate\s*\([^,)]+,\s*['"](?:added|efp)['"]/.test(region);
  // Source priority in scoring: 'added' wins ties.
  const hasSourcePriority = /source\s*===?\s*['"]added['"]|source\s*!==?\s*['"]efp['"]/.test(region);
  assert.ok(hasSourceArg && hasSourcePriority,
    'auto-discovery must tag each candidate with source (pushCandidate(el, "added"|"efp")) and ' +
    'prefer "added" over "efp" as a tiebreaker in the scoring cascade. The addedNodes signal is the ' +
    'strongest universal hovercard-mount indicator.');
});

test('domHover auto-discovery diagnostic emits dwellMs and per-candidate source (RC41 observability)', () => {
  // Diagnostic continuation: without dwellMs in the payload, we can't tell
  // whether a picked-noise iteration happened at T=0 (dwell gate broken) or
  // T=500+ (dwell gate worked but scoring still picked noise). Without
  // per-candidate source, we can't tell whether the picked candidate was the
  // new (added) hovercard or pre-existing efp noise. Both fields are needed
  // to triage future hover incidents from the SW log alone.
  const cs = readSrc('content-script.js');
  const fnStart = cs.indexOf('async function domHover(');
  const fnEnd = cs.indexOf('async function domOpenTab(', fnStart);
  const fnBody = cs.slice(fnStart, fnEnd);
  assert.ok(fnStart > -1 && fnEnd > fnStart, 'domHover must exist');

  const autoDiscoverStart = fnBody.indexOf('Path (b): auto-discovery');
  const autoDiscoverEnd = fnBody.indexOf('observer.disconnect()', autoDiscoverStart);
  assert.ok(autoDiscoverStart > -1 && autoDiscoverEnd > autoDiscoverStart,
    'auto-discovery region must be sliceable');
  const region = fnBody.slice(autoDiscoverStart, autoDiscoverEnd);

  const hasDwellMs = /dwellMs\s*:/.test(region);
  const hasSourceInSummary = /source\s*:\s*c\.source|source\s*:\s*(?:candidate|c)\.source/.test(region);
  assert.ok(hasDwellMs && hasSourceInSummary,
    'hover_auto_discover diagnostic must include dwellMs (how long we waited before scoring) and ' +
    'source per candidate (added vs efp) in picked and considered[] summaries. Without these, future ' +
    'hover incidents cannot be triaged from the SW log alone.');
});
