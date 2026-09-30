// extension/test/session-universality.test.js
//
// Spec goal 6: universality preserved — no site tokens in the new session
// layer sources (incl. comments). The guard pattern from
// dsl-guide-no-site-specific.test.js, applied to the Plan-3 libs.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const LIBS = [
  'session-persistence.js', 'live-rail.js', 'verify-runner.js', 'session-tools.js',
  'research-session.js', 'probe-tools.js'
].map((f) => path.join(__dirname, '..', 'lib', f));

const RE = /facebook|twitter|linkedin|tiktok|reddit|\bfb\b/i;

describe('session-layer universality', () => {
  for (const file of LIBS) {
    it(path.basename(file) + ' carries no site tokens', () => {
      const src = fs.readFileSync(file, 'utf8');
      assert.ok(!RE.test(src), path.basename(file) + ' contains a site token');
    });
  }
  it('the DSL-contract system prompt carries no site tokens', () => {
    const { buildDslContractPrompt } = require('../lib/session-tools');
    assert.ok(!RE.test(buildDslContractPrompt()));
  });
});

// 182b round (user audit: "did repeated FB iterations solidify a same-site
// seed into the system?"). The seed machinery never fired in any live log
// (zero 'Ledger seeded' lines) — but the audit surfaced FB-DERIVED SHAPES
// living as EXAMPLES in prompt-bearing text: one vendor's CDN fragment
// (scontent), its feed composition (role=feed + aria-posinset), and its
// legacy permalink shape (story.php). Mechanisms stay generic; examples
// must not smuggle one site's fingerprints.
describe('182b round: prompt surfaces carry no single-vendor fingerprints', () => {
  const fsB = require('node:fs');
  const pathB = require('node:path');
  const WU = fsB.readFileSync(pathB.join(__dirname, '../lib/wizard-utils.js'), 'utf8');
  const KU = fsB.readFileSync(pathB.join(__dirname, '../lib/knowledge-units.js'), 'utf8');
  const VENDOR = /scontent|pfbid|fbclid|__cft__|story\.php/i;

  it('the assembled DSL guide examples are vendor-neutral', () => {
    // The REAL prompt surface: the assembled guide string (comments in the
    // source file are incident history, not prompt text).
    const ST = require('../lib/session-tools');
    const guide = String(ST.buildDslContractPrompt ? ST.buildDslContractPrompt() : '');
    assert.ok(guide.length > 1000, 'guide assembled');
    assert.ok(!VENDOR.test(guide), 'vendor fingerprint in the assembled DSL guide');
  });
  it('knowledge-unit bodies are vendor-neutral (origins may name the incident)', () => {
    // Only the BODY strings (teaching text) — origin fields are history.
    const bodies = Array.from(KU.matchAll(/body: '((?:[^'\\]|\\.)*)'/g)).map((m) => m[1]);
    const offenders = bodies.filter((b) => VENDOR.test(b));
    assert.deepEqual(offenders, [], 'vendor fingerprints in knowledge-unit teaching bodies');
  });
});
