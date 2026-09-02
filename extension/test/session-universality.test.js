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
