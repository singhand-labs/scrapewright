// Thirty-third log D3: v2's verify showed postingTime populated 1/2 (a junk
// value, but the SPAN was there); v3's verify showed 0/2 zero-match — the
// model's own v3 change (load step exits on first no-growth → extract at ~5s
// instead of ~25s) caused the disappearance, yet nothing connected the two
// runs and the model concluded "session-state-dependent, never reproduces on
// fresh loads" and shipped best-effort. Cross-verify memory: when a field
// that a PRIOR verify populated comes back fully empty, say so — the first
// suspect is the step changes between the runs, not permanent absence.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createResearchSession } = require('../lib/research-session');
const VR = require('../lib/verify-runner');

function reply(content) {
  return { content, finish_reason: 'stop', usage: { prompt_tokens: 100, completion_tokens: 10 } };
}
function envelope(tool, args) {
  return JSON.stringify({ think: 't', tool, args: args || {} });
}
function finishEnvelope(summary) { return JSON.stringify({ think: 'done', finish: { summary: summary || 'done' } }); }

const DECOY = 'eporntosdS9u77m62gllh0i16i81a1l5gcf7hg2taf545h7tcu9c32mt5i9c';

function v2Report() {
  return {
    ok: false,
    error: { message: 'REQUIRED_FIELD_EMPTY: posts.postingTime is empty in 1/2 records but the confirmed contract lists it as REQUIRED for every record. Either fix the extraction, or renegotiate the contract with io.confirm when it genuinely never exists on these cards.' },
    detectors: {
      partialEmptyFields: [
        { field: 'postingTime', path: 'posts.postingTime', emptyCount: 1, totalCount: 2, emptyRatio: 0.5, sampleNonEmpty: [DECOY] },
        { field: 'commentCount', path: 'posts.commentCount', emptyCount: 2, totalCount: 2, emptyRatio: 1, sampleNonEmpty: [] }
      ]
    },
    events: ['REQUIRED_FIELD_EMPTY', 'PARTIAL_EMPTY_FIELDS']
  };
}
function v3Report() {
  return {
    ok: false,
    error: { message: 'REQUIRED_FIELD_EMPTY: posts.postingTime is empty in 2/2 records but the confirmed contract lists it as REQUIRED for every record. Either fix the extraction, or renegotiate the contract with io.confirm when it genuinely never exists on these cards.' },
    detectors: {
      partialEmptyFields: [
        { field: 'postingTime', path: 'posts.postingTime', emptyCount: 2, totalCount: 2, emptyRatio: 1, sampleNonEmpty: [] }
      ],
      emptyFieldDiagnostics: [
        { field: 'postingTime', path: 'posts.postingTime', emptyCount: 2, totalCount: 2, crumbs: [{ stepId: 'extract', api: 'extractList', selector: 'span[aria-labelledby]', note: 'sub-selector for field "postingTime" matched 0 of 2 containers' }] }
      ]
    },
    events: ['REQUIRED_FIELD_EMPTY', 'PARTIAL_EMPTY_FIELDS']
  };
}

describe('detectFieldRegression (pure)', () => {
  it('fires when a prior verify populated a field the current one empties completely', () => {
    const prior = Object.assign({ executedArtifactVersion: 2 }, v2Report());
    const current = v3Report();
    const r = VR.detectFieldRegression(current, prior, 3);
    assert.ok(r, 'detector fires');
    const f = r.fields.find((x) => x.path === 'posts.postingTime');
    assert.ok(f, 'postingTime entry');
    assert.equal(f.priorEmpty, '1/2');
    assert.equal(f.nowEmpty, '2/2');
    assert.equal(f.priorVersion, 2);
    assert.equal(f.priorSample, DECOY);
    assert.equal(f.sameVersion, false);
    assert.ok(/prior verify/i.test(r.note), 'note names the prior verify');
    assert.ok(/never exists|permanent absence/i.test(r.note), 'note warns against permanent-absence conclusions');
  });

  it('same artifact version both runs → sameVersion timing-flakiness note', () => {
    const prior = Object.assign({ executedArtifactVersion: 3 }, v2Report());
    const r = VR.detectFieldRegression(v3Report(), prior, 3);
    assert.ok(r);
    assert.equal(r.fields[0].sameVersion, true);
    assert.ok(/flak/i.test(r.note), 'note names flakiness for same-version flips');
  });

  it('stays silent when the prior run was already fully empty, or no prior, or no full-empty now', () => {
    const priorFullEmpty = { executedArtifactVersion: 2, detectors: { partialEmptyFields: [
      { field: 'postingTime', path: 'posts.postingTime', emptyCount: 2, totalCount: 2, emptyRatio: 1, sampleNonEmpty: [] }
    ] } };
    assert.equal(VR.detectFieldRegression(v3Report(), priorFullEmpty, 3), null);
    assert.equal(VR.detectFieldRegression(v3Report(), null, 3), null);
    const currentPartial = { detectors: { partialEmptyFields: [
      { field: 'postingTime', path: 'posts.postingTime', emptyCount: 1, totalCount: 2, emptyRatio: 0.5, sampleNonEmpty: ['x'] }
    ] } };
    assert.equal(VR.detectFieldRegression(currentPartial, Object.assign({ executedArtifactVersion: 2 }, v2Report()), 3), null);
  });
});

describe('cross-verify regression wiring (research-session)', () => {
  it('second verify report carries fieldRegression + event tag + error pointer, and the next LLM call sees it', async () => {
    const calls = [];
    const events = [];
    let n = 0;
    const session = createResearchSession({
      requirement: 'collect posts',
      llm: async (req) => {
        calls.push(req);
        n += 1;
        if (n === 1) return reply(envelope('verify.run', {}));
        if (n === 2) return reply(envelope('verify.run', {}));
        return reply(finishEnvelope('shipped'));
      },
      tools: {
        'verify.run': async () => (n === 1 ? v2Report() : v3Report())
      },
      onEvent: (e) => events.push(e)
    });
    await session.run();
    const secondDetail = events.filter((e) => e.type === 'tool_result' && e.tool === 'verify.run')[1];
    assert.ok(secondDetail, 'second verify event exists');
    assert.match(secondDetail.detail, /fieldRegression/, 'compact detail carries the regression key');
    assert.match(secondDetail.verify.tags.join(','), /FIELD_REGRESSION/, 'digest tags carry the event');
    // The model's next request must contain the regression teaching (the
    // payoff: it cannot conclude "never reproduces" without addressing it).
    const lastReq = calls[calls.length - 1];
    const flat = JSON.stringify(lastReq);
    assert.match(flat, /FIELD_REGRESSION|fieldRegression/, 'next LLM request carries the regression signal');
    assert.match(flat, /prior verify/i, 'request explains the prior-run provenance');
  });

  it('first verify (no prior) carries no fieldRegression', async () => {
    const events = [];
    let n = 0;
    const session = createResearchSession({
      requirement: 'collect posts',
      llm: async () => {
        n += 1;
        return n === 1 ? reply(envelope('verify.run', {})) : reply(finishEnvelope('done'));
      },
      tools: { 'verify.run': async () => (n === 1 ? v2Report() : v3Report()) },
      onEvent: (e) => events.push(e)
    });
    await session.run();
    const first = events.filter((e) => e.type === 'tool_result' && e.tool === 'verify.run')[0];
    assert.ok(first);
    assert.doesNotMatch(first.detail, /fieldRegression/);
  });
});
