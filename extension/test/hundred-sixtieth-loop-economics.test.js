// extension/test/hundred-sixtieth-loop-economics.test.js
//
// 160th round (spec A/B/D/E): loop economics + spot-check provenance.
// Evidence base: docs/sessionlog.log (159th session) — 26 snippets with 2
// DSL-argument errors while probe.extract was used once; a 165s
// OUTER_DEADLINE red verify from an oversized hover batch; the final
// spot-check verify (travel/5) overwrote the contract run (beauty/10) in
// the panel. Item C (verify-receipt aging) was WITHDRAWN on measurement:
// history tool entries already carry ~200-char summaries; the per-turn
// constant is the 65KB system layer, not history.
const { test, describe, it } = require('node:test');
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const RS = fs.readFileSync(path.join(__dirname, '..', 'lib', 'research-session.js'), 'utf8');
const LLC = fs.readFileSync(path.join(__dirname, '..', 'lib', 'llm-client.js'), 'utf8');
const ST = fs.readFileSync(path.join(__dirname, '..', 'lib', 'session-tools.js'), 'utf8');
const LEO = fs.readFileSync(path.join(__dirname, '..', 'lib', 'list-extract-ops.js'), 'utf8');
const CS = fs.readFileSync(path.join(__dirname, '..', 'content-script.js'), 'utf8');
const VR = fs.readFileSync(path.join(__dirname, '..', 'lib', 'verify-runner.js'), 'utf8');
const WU = require('../lib/wizard-utils');
const WJ = fs.readFileSync(path.join(__dirname, '..', 'wizard.js'), 'utf8');

describe('160 A — prompt_digest + usage ride the journal', () => {
  it('prompt_digest feeds the page journal sink (best-effort guarded)', () => {
    const i = RS.indexOf("console.log('[session] prompt_digest '");
    assert.ok(i > -1, 'digest console line found');
    const block = RS.slice(i, i + 1200);
    assert.match(block, /__scrapewrightJournalSink/, 'the same digest rides the sink');
    assert.match(block, /typeof window !== 'undefined'/, 'guarded for non-page contexts');
  });
  it('response usage goes through logContentChunks (which feeds the sink)', () => {
    const i = LLC.indexOf('[LLMClient] Response usage');
    assert.ok(i > -1);
    const block = LLC.slice(i - 200, i + 300);
    assert.match(block, /logContentChunks\('\[LLMClient\] Response usage'/, 'usage line via the chunker+sink path');
  });
});
