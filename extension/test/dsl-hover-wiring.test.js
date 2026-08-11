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
