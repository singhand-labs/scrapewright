// RC24 B — De-specialization audit.
//
// The user's original direction: solutions must consider framework and prompt
// template issues, must not hardcode FB-specific features, must preserve
// universality. SCRIPT_DSL_GUIDE had accreted many FB-specific example tokens
// (div[role="article"], data-ad-comet-preview, "3天" Chinese dates, AI-chat
// class cosd-markdown-loading, bid-site classes .ewb-* / zbggframe, etc.)
// across many RCs. Each was added to teach a generic rule with the site the
// author happened to be debugging. Over time this taught the LLM that those
// tokens were the canonical patterns, biasing generation toward FB-shaped
// selectors even on completely different sites.
//
// This test guards against re-introduction of site-specific tokens in
// SCRIPT_DSL_GUIDE. When you need to illustrate a rule, use a neutral
// equivalent (li.product-card, .search-result, .generating-indicator, etc.).
// One whitelist exception: _chat-container_r2am5_1 — it is the canonical CSS
// module hash teaching example for the SELECTOR FIDELITY RULE, which the rule
// literally cannot demonstrate without a real hash.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const UTILS_PATH = path.join(__dirname, '..', 'lib', 'wizard-utils.js');
const WIZARD_PATH = path.join(__dirname, '..', 'wizard.js');

function loadScriptDslGuide() {
  const src = fs.readFileSync(UTILS_PATH, 'utf8');
  const startIdx = src.indexOf('SCRIPT_DSL_GUIDE');
  assert.ok(startIdx > -1, 'wizard-utils.js: SCRIPT_DSL_GUIDE not found');
  const eqIdx = src.indexOf('=', startIdx);
  const btIdx = src.indexOf('`', eqIdx);
  assert.ok(btIdx > -1, 'wizard-utils.js: SCRIPT_DSL_GUIDE opening backtick not found');
  // The const declaration ends with `; (backtick + semicolon). The body
  // itself contains inline backticks (escaped \` for code spans), so we look
  // for the literal `\`;` sequence that terminates the template literal.
  const endMarker = '`;';
  const endIdx = src.indexOf(endMarker, btIdx + 1);
  assert.ok(endIdx > btIdx, 'wizard-utils.js: SCRIPT_DSL_GUIDE closing backtick-semicolon not found');
  return src.slice(btIdx + 1, endIdx);
}

describe('SCRIPT_DSL_GUIDE is free of site-specific tokens (RC24 B)', () => {
  const guide = loadScriptDslGuide();

  it('does not mention Facebook, Twitter, TikTok, Reddit, LinkedIn by name', () => {
    assert.doesNotMatch(guide, /Facebook/i);
    assert.doesNotMatch(guide, /Twitter/i);
    assert.doesNotMatch(guide, /TikTok/i);
    assert.doesNotMatch(guide, /Reddit/i);
    assert.doesNotMatch(guide, /LinkedIn/i);
  });

  it('does not use FB-specific data-ad-* attributes', () => {
    assert.doesNotMatch(guide, /data-ad-comet-preview/i);
    assert.doesNotMatch(guide, /data-ad-rendering-role/i);
  });

  it('does not use FB-specific "a strong" author selector pattern in examples', () => {
    assert.doesNotMatch(guide, /author:\s*['"]a strong['"]/);
  });

  it('does not use the FB role="link" + aria-label + Chinese-date example', () => {
    assert.doesNotMatch(guide, /aria-label=["']\d+月/);
    assert.doesNotMatch(guide, /\d+月\d+日/);
  });

  it('does not use AI-chat-specific class cosd-markdown-loading in DSL guide', () => {
    assert.doesNotMatch(guide, /cosd-markdown-loading/);
  });

  it('does not use bid-site-specific .ewb-* or zbggframe tokens', () => {
    assert.doesNotMatch(guide, /ewb-info/i);
    assert.doesNotMatch(guide, /ewb-enclosure/i);
    assert.doesNotMatch(guide, /zbggframe/i);
  });

  it('retains _chat-container_r2am5_1 as whitelisted CSS-module-hash teaching example', () => {
    // This is the canonical CSS module hash example — the SELECTOR FIDELITY
    // RULE needs it to demonstrate "copy hashes verbatim". Removing it would
    // weaken the rule.
    assert.match(guide, /_chat-container_r2am5_1/);
  });

  it('does not use publishTime/comments/shares/likes as field names in examples', () => {
    assert.doesNotMatch(guide, /\bpublishTime\b/);
    assert.doesNotMatch(guide, /\bshares:\s/);
    assert.doesNotMatch(guide, /\blikes:\s/);
  });
});

// RC57 (2026-08-18 audit): wizard.js inline prompts had leaked a real FB
// search URL (exploration targetUrlTemplate example) and publishTime/posts
// autoFix examples; wizard.html UI copy had publishTime/posts placeholders.
// The existing guard only checked cosd-markdown-loading in wizard.js — the
// gap that let the URL example survive. Sweep non-comment wizard.js source,
// the full DSL guide, and wizard.html visible text for site names and
// site-fingerprint tokens. (options.html intentionally unguarded: its
// "Facebook feeds" limitation hint is docs-class descriptive copy, same as
// the README lazy-load heading.)
const SITE_NAME_RE = /facebook|twitter|linkedin|tiktok|reddit|instagram|\bfb\.com|weibo|zhihu|douyin/i;

describe('wizard.js inline prompt sections are free of site-specific tokens', () => {
  const src = fs.readFileSync(WIZARD_PATH, 'utf8');
  const withoutComments = src.replace(/\/\/[^\n]*\n/g, '').replace(/\/\*[\s\S]*?\*\//g, '');

  it('does not reference cosd-markdown-loading in inline prompts', () => {
    assert.doesNotMatch(withoutComments, /cosd-markdown-loading/);
  });

  it('has no site names anywhere outside comments', () => {
    assert.doesNotMatch(withoutComments, SITE_NAME_RE);
  });

  it('has no FB-fingerprint endpoint profile.php anywhere outside comments', () => {
    assert.doesNotMatch(withoutComments, /profile\.php/i);
  });

  it('has no publishTime field name outside comments', () => {
    // publishTime is FB-shaped (guard already bans it in the DSL guide);
    // wizard.js autoFix examples and UI placeholders must use neutral names.
    assert.doesNotMatch(withoutComments, /publishTime/);
  });
});

describe('SCRIPT_DSL_GUIDE has no FB-fingerprint href patterns (RC57)', () => {
  const guide = loadScriptDslGuide();
  it('does not use profile.php as an href discriminator example', () => {
    assert.doesNotMatch(guide, /profile\.php/i);
  });
});

describe('wizard.html visible text is free of site-specific tokens (RC57)', () => {
  it('has no site names or FB-fingerprint tokens in UI copy', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'wizard.html'), 'utf8');
    assert.doesNotMatch(src, SITE_NAME_RE);
    assert.doesNotMatch(src, /profile\.php/i);
    assert.doesNotMatch(src, /publishTime/);
  });
});
