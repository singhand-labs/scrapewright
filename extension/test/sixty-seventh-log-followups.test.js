// extension/test/sixty-seventh-log-followups.test.js
// Sixty-seventh log — 60 turns burned on 8 BLIND service.update calls +
// 4 verify rounds while probe.snippet (the test-before-artifact tool) got
// ZERO uses: the postId regex was written against a digit-only hoped-for
// shape on non-numeric observed ids and stayed empty 2/2 through every
// rewrite; the final turn wrote artifact v7 that could never be verified.
// F1 routes the red-verify moment snippet-first; F2 auto-attaches a
// knowledge unit on the red tags; F3 warns in the update receipt when the
// endgame (≤2 turns left) cannot afford an unverifiable rewrite.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { KNOWLEDGE_UNITS } = require('../lib/knowledge-units');
const { createSessionTools } = require('../lib/session-tools');

const LIB = (f) => fs.readFileSync(path.join(__dirname, '..', 'lib', f), 'utf8');

// ---------------------------------------------------------------------------
// F2: knowledge unit verify-red-snippet-first
describe('F2: knowledge unit verify-red-snippet-first (sixty-seventh log)', () => {
  it('exists, keyed to REQUIRED_FIELD_EMPTY and the red-tag family', () => {
    const u = KNOWLEDGE_UNITS.find((x) => x.id === 'verify-red-snippet-first');
    assert.ok(u, 'unit exists');
    assert.ok(u.matchEvents.includes('REQUIRED_FIELD_EMPTY'));
    for (const ev of ['PARTIAL_EMPTY_FIELDS', 'JUNK_VALUES', 'COUNT_SHORTFALL', 'TIME_FIELD_IMPLAUSIBLE', 'SCHEMA_STRAY_FIELD_DECLS']) {
      assert.ok(u.matchEvents.includes(ev), ev + ' keyed');
    }
    assert.ok(u.title && u.body, 'schema parity with sibling units (title + body)');
  });

  it('body teaches probe.snippet dry-run against OBSERVED values', () => {
    const u = KNOWLEDGE_UNITS.find((x) => x.id === 'verify-red-snippet-first');
    assert.match(u.body, /probe\.snippet/);
    assert.match(u.body, /OBSERVED/);
    assert.match(u.body, /non-numeric/, 'teaches id shapes without site tokens');
  });
});

// ---------------------------------------------------------------------------
// F1: verify-runner teaching (source audits)
describe('F1: verify-runner snippet-first routing (sixty-seventh log)', () => {
  it('REQUIRED_FIELD_EMPTY error names probe.snippet and the blind-pair cost', () => {
    const src = LIB('verify-runner.js');
    const m = src.match(/REQUIRED_FIELD_EMPTY: ' \+ pe\.path[\s\S]{0,2400}?does not\.'/);
    assert.ok(m, 'error-construction block found');
    assert.match(m[0], /probe\.snippet/);
    assert.match(m[0], /2 turns/);
    assert.match(m[0], /non-numeric ids/);
  });

  it('partial-empty census note carries the shorter snippet-first tail', () => {
    const src = LIB('verify-runner.js');
    const m = src.match(/PARTIAL_EMPTY_FIELDS census:[\s\S]{0,900}?hoped-for shapes\./);
    assert.ok(m, 'census note found');
    assert.match(m[0], /probe\.snippet/);
    assert.match(m[0], /emptyRecordSamples/);
  });
});

// ---------------------------------------------------------------------------
// F3: endgame no-unverifiable-updates
function makeDeps() {
  const state = { applied: [], draft: null };
  const deps = {
    rail: {
      pageOpen: async () => ({ tabId: 1, url: 'https://example.com', ready: true }),
      pageState: async () => ({ open: true, tabId: 1, url: 'https://example.com' }),
      executeDsl: async () => 5,
      ensureLock: async () => {}, releaseLock: async () => {}, dispose: async () => {}, tabId: 1
    },
    runVerify: async () => ({ report: { ok: true, error: null, aborted: false, score: { score: 100, isData: true, breakdown: {} }, schemaOk: true, schemaMissing: [], detectors: { emptyFields: [], duplicateFields: [], countShortfall: null }, steps: [], finalResult: { posts: [{ t: 1 }] }, pages: '1', eventCount: 2, events: [] }, events: [], raw: {} }),
    getDraftService: () => state.draft,
    applyArtifact: (a) => { state.applied.push(a); state.draft = { targetUrl: 'https://example.com', steps: a.steps, testInput: a.testInput, inputSchema: a.inputSchema, outputSchema: a.outputSchema }; },
    getTestInput: () => (state.draft ? state.draft.testInput : null),
    getOutputSchema: () => (state.draft ? state.draft.outputSchema : null),
    getSteps: () => (state.draft ? state.draft.steps : []),
    annotationBridge: null,
    ioConfirmBridge: { request: async () => ({ confirmed: true }) }
  };
  return { deps, state };
}

const IN = { type: 'object', required: ['keyword'], properties: { keyword: { type: 'string' } } };
const OUT = { type: 'object', required: ['posts'], properties: { posts: { type: 'array', items: { type: 'object' } } } };
const STEPS = [
  { id: 's1', name: 'extract', script: "return $extractList('div.card', {t:{selector:'.t'}});", onSuccess: 'TERMINATE', onFailure: 'TERMINATE' }
];

async function confirmedTools() {
  const { deps } = makeDeps();
  const t = createSessionTools(deps);
  await t.tools['io.confirm']({ inputSchema: IN, outputSchema: OUT });
  return t;
}

describe('F3: service.update endgame warning (sixty-seventh log)', () => {
  it('turns 59/60 → receipt.warning names the unverifiable-update risk', async () => {
    const t = await confirmedTools();
    const ctx = { session: { state: () => ({ session: { artifactVersions: [] } }), spend: { turns: 59 }, budgets: { maxTurns: 60 } } };
    const upd = await t.tools['service.update']({ steps: STEPS }, ctx);
    assert.equal(upd.updated, true);
    assert.ok(upd.warning, 'warning present');
    assert.match(String(upd.warning), /turn\(s\) left/);
    assert.match(String(upd.warning), /cannot verify/);
  });

  it('turns 58/60 (turnsLeft=2) still warns; 30/60 does not', async () => {
    const t = await confirmedTools();
    const edge = await t.tools['service.update']({ steps: STEPS }, { session: { state: () => ({ session: { artifactVersions: [] } }), spend: { turns: 58 }, budgets: { maxTurns: 60 } } });
    assert.match(String(edge.warning || ''), /turn\(s\) left/);
    const calm = await t.tools['service.update']({ steps: STEPS }, { session: { state: () => ({ session: { artifactVersions: [] } }), spend: { turns: 30 }, budgets: { maxTurns: 60 } } });
    assert.equal(calm.warning, undefined, 'no endgame warning mid-session');
  });

  it('no spend/budgets on ctx → no warning, no crash', async () => {
    const t = await confirmedTools();
    const upd = await t.tools['service.update']({ steps: STEPS }, { session: { state: () => ({ session: { artifactVersions: [] } }) } });
    assert.equal(upd.updated, true);
    assert.equal(upd.warning, undefined);
  });
});

// ---------------------------------------------------------------------------
// 90% budget advisory + probe.snippet spec + universality guard
describe('F3 misc + universality (sixty-seventh log)', () => {
  it('the 90% budget advisory teaches no unverifiable endgame updates', () => {
    const src = LIB('research-session.js');
    assert.ok(src.includes('do NOT write another update you cannot verify'),
      'advisory text extended');
    assert.match(src, /finish with the last verified artifact and disclose/);
  });

  it('probe.snippet spec advises testing against real values before rewriting', () => {
    const src = LIB('session-tools.js');
    const m = src.match(/\{ name: 'probe\.snippet'[\s\S]{0,900}?\},/);
    assert.ok(m, 'spec entry found');
    assert.match(m[0], /Test-before-artifact/i);
    assert.match(m[0], /BEFORE writing it into service\.update/);
  });

  it('no site tokens in any of the touched teaching surfaces', () => {
    const FORBIDDEN = /facebook|twitter|linkedin|tiktok|reddit|\bfb\b|pfbid/i;
    const vr = LIB('verify-runner.js');
    const unit = KNOWLEDGE_UNITS.find((x) => x.id === 'verify-red-snippet-first');
    const st = LIB('session-tools.js').match(/function endgameWarning[\s\S]{0,1400}?^    }/m);
    const surfaces = [
      vr.match(/REQUIRED_FIELD_EMPTY: ' \+ pe\.path[\s\S]{0,2400}?does not\.'/) && vr.match(/REQUIRED_FIELD_EMPTY: ' \+ pe\.path[\s\S]{0,2400}?does not\./)[0],
      vr.match(/PARTIAL_EMPTY_FIELDS census:[\s\S]{0,900}?hoped-for shapes\./)[0],
      unit.title + ' ' + unit.origin + ' ' + unit.body,
      st && st[0],
      LIB('research-session.js').match(/BUDGET ADVISORY \(90%[^']*/)[0]
    ];
    for (let i = 0; i < surfaces.length; i++) {
      assert.ok(surfaces[i], 'surface ' + i + ' extracted');
      assert.doesNotMatch(surfaces[i], FORBIDDEN, 'surface ' + i + ' is site-token-free');
    }
  });
});
