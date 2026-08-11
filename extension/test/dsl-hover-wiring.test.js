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

test('domHover auto-discovery filters candidates by position + z-index (RC37 popover mis-detection)', () => {
  // console.log 2026-08-11 14:34: even with RC36 observer-before-dispatch
  // fixed, hover enrichment still returned empty fields across all posts.
  // The hover dispatched (dispatched:true ok:true) and the observer caught
  // added nodes — but auto-discovery picked up the WRONG nodes: gradient
  // placeholder divs (`<div style="background-image: linear-gradient(...)">`)
  // and video-player scaffolding (with a "播放视频" button). Both satisfied
  // the existing visibility + >=50x50px filter. Real popovers never made it
  // into htmlSnippet because the reverse walk picks the LATEST added node,
  // and these noise nodes are appended after the popover.
  //
  // The universal distinguishing signal: real popovers (React Portal,
  // Vue Teleport, Popper, Floating UI, Tippy, any site-specific hovercard
  // framework) are positioned `absolute` or `fixed` AND carry a numeric
  // z-index so they overlay the surrounding content. Gradient placeholders,
  // video scaffolding, and analytics pixels injected during hover handlers
  // don't have these properties — they're statically positioned in the
  // normal flow.
  //
  // This test pins the filter: the auto-discovery loop MUST call
  // getComputedStyle and reject candidates whose position is `static`/
  // `relative`/`sticky` or whose z-index is `auto`. Without this, the
  // auto-discovery path returns htmlSnippets of non-popover noise and
  // the LLM has no way to recover.
  const cs = readSrc('content-script.js');
  const fnStart = cs.indexOf('async function domHover(');
  const fnEnd = cs.indexOf('async function domOpenTab(', fnStart);
  const fnBody = cs.slice(fnStart, fnEnd);
  assert.ok(fnStart > -1 && fnEnd > fnStart, 'domHover must exist');

  // Slice just the auto-discovery loop region (after observer setup, before
  // the dismiss block). This isolates the filter from any unrelated
  // getComputedStyle calls elsewhere in the function.
  const autoDiscoverStart = fnBody.indexOf('Path (b): auto-discovery');
  const autoDiscoverEnd = fnBody.indexOf('observer.disconnect()', autoDiscoverStart);
  assert.ok(autoDiscoverStart > -1, 'auto-discovery comment block must exist');
  assert.ok(autoDiscoverEnd > autoDiscoverStart, 'auto-discovery loop must end before observer.disconnect');
  const loopBody = fnBody.slice(autoDiscoverStart, autoDiscoverEnd);

  // Must call getComputedStyle during auto-discovery.
  assert.match(loopBody, /getComputedStyle/,
    'auto-discovery must call getComputedStyle to check stacking signals');

  // Must reject candidates whose position is NOT absolute/fixed.
  // Accept either an allow-list check (position === 'absolute' || 'fixed')
  // or a deny-list check (!== 'static' etc.). Either pattern satisfies the
  // universal requirement. We assert by checking the position property is
  // read at all.
  assert.match(loopBody, /\.position\b/,
    'auto-discovery must read computed style .position to filter by absolute/fixed');

  // Must reject candidates whose z-index is `auto` (the default for elements
  // that don't create a stacking context). Real popovers have a numeric
  // z-index so they overlay page content.
  assert.match(loopBody, /\.zIndex\b/,
    'auto-discovery must read computed style .zIndex to filter out non-overlaying elements');
});
