// extension/test/fifty-fifth-log-followups.test.js
// Fifty-fifth log — the first glm-5.1 green completion via a custom coding
// gateway (http://coding.singhand.com), 57 turns, zero protocol violations,
// v7 score 183.98. The 52nd-round machinery fired in production for the
// first time (STAGNANT_DISCLOSURES on a red run; TIME_FIELD_IMPLAUSIBLE on
// the final green) — and the model STILL shipped postTime="Learn More" on
// 5/8 records (a BUTTON LABEL read from a[target=_blank]'s labelledby) and
// postId as the small position integers 3..11 (aria-posinset misread),
// because both classes are report-only and the finish disclosure ladder
// carries only PARTIAL-EMPTY / COUNT-SHORTFALL / RELATIVE-TIMESTAMPS — the
// user reading the completion toast never learns the time field is garbage.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createResearchSession } = require('../lib/research-session');
const { createVerifyRunner } = require('../lib/verify-runner');
const WU = require('../lib/wizard-utils');
const { KNOWLEDGE_UNITS } = require('../lib/knowledge-units');

function scriptedLlm(replies, calls) {
  let i = 0;
  return async (req) => {
    calls.push(req);
    const r = replies[Math.min(i, replies.length - 1)];
    i++;
    return r;
  };
}
function reply(content) {
  return { content, finish_reason: 'stop', usage: { prompt_tokens: 100, completion_tokens: 10 } };
}
function envelope(tool, args) {
  return JSON.stringify({ think: 't', tool, args: args || {} });
}
function finishEnvelope(summary) { return JSON.stringify({ think: 'done', finish: { summary: summary || 'done' } }); }

// The fifty-fifth-log final verify shape (abridged to the fields under test).
function greenVerifyWithJunkTime() {
  return {
    ok: true, error: null, aborted: false,
    score: { score: 183.98, isData: true, breakdown: {} },
    schemaOk: true, schemaMissing: [],
    detectors: {
      emptyFields: [], duplicateFields: [], countShortfall: { field: 'posts', requested: 10, extracted: 8, severe: false },
      partialEmptyFields: [
        { field: 'location', path: 'posts.location', emptyCount: 6, totalCount: 8 },
        { field: 'likeCount', path: 'posts.likeCount', emptyCount: 8, totalCount: 8 }
      ],
      relativeTimestamps: [],
      implausibleTimeFields: [
        { field: 'postTime', path: 'posts.postTime', nonEmpty: 7, implausibleCount: 5, sample: 'Learn More' }
      ],
      junkValues: { fields: [
        { field: 'posts.permalink', kind: 'queryBlob', count: 8, sample: '?__cft__…' }
      ] },
      positionLikeIds: [
        { field: 'postId', path: 'posts.postId', count: 8, sample: '3' }
      ]
    },
    steps: [], finalResult: { posts: [{ postId: '1' }] }, pages: '1', eventCount: 9,
    events: ['COUNT_FIELD_HIDDEN_VALUE', 'TIME_FIELD_IMPLAUSIBLE', 'CARD_POLICY', 'JUNK_VALUES', 'OUTPUT_FIELD_SIZE', 'PARTIAL_EMPTY_FIELDS']
  };
}

// ---------------------------------------------------------------------------
// F1: the finish disclosure ladder names junk time fields + junk values
describe('F1: finish ladder discloses implausible time + junk fields (fifty-fifth log)', () => {
  it('a green finish after a junk-carrying verify discloses TIME-IMPLAUSIBLE with the sample, plus JUNK-VALUES and POSITION-LIKE-IDS', async () => {
    const session = createResearchSession({
      requirement: 'collect posts',
      llm: scriptedLlm([
        reply(envelope('verify.run', {})),
        reply(finishEnvelope('shipped v7'))
      ], []),
      tools: { 'verify.run': async () => greenVerifyWithJunkTime() }
    });
    const report = await session.run();
    assert.equal(report.stopped.reason, 'completed');
    const detail = report.stopped.detail;
    assert.match(detail, /TIME-IMPLAUSIBLE/i, 'time garbage named: ' + detail.slice(-600));
    assert.ok(detail.includes('Learn More'), 'the offending sample rides the disclosure');
    assert.match(detail, /JUNK-VALUES/i, 'junk fields named');
    assert.ok(detail.includes('posts.permalink'), 'the junk field list named');
    assert.match(detail, /POSITION-LIKE/i, 'position-index ids named');
    assert.match(detail, /PARTIAL-EMPTY/, 'existing ladder disclosures preserved');
  });

  it('a maxTurns stop carries the same junk disclosures via verifyStopSuffix', async () => {
    // one verify turn then run out of turns (maxTurns 1)
    const session = createResearchSession({
      requirement: 'collect posts',
      budgets: { maxTurns: 1, wallClockMs: 3_600_000 },
      llm: scriptedLlm([
        reply(envelope('verify.run', {})),
        reply(envelope('verify.run', {}))
      ], []),
      tools: { 'verify.run': async () => greenVerifyWithJunkTime() }
    });
    const report = await session.run();
    assert.equal(report.stopped.reason, 'maxTurns');
    assert.match(report.stopped.detail, /TIME-IMPLAUSIBLE/i);
    assert.match(report.stopped.detail, /POSITION-LIKE/i);
  });
});

// ---------------------------------------------------------------------------
// F2: position-like id census (aria-posinset misread)
describe('F2: detectPositionLikeIds (fifty-fifth log)', () => {
  const SCHEMA = { type: 'object', required: ['posts'], properties: { posts: { type: 'array', items: { type: 'object', properties: {
    postId: { type: 'string' }, content: { type: 'string' }
  } } } } };

  it('the fifty-fifth-log values (3..11 ascending small integers) are flagged', () => {
    const data = { posts: [
      { postId: '3' }, { postId: '4' }, { postId: '5' }, { postId: '6' },
      { postId: '7' }, { postId: '9' }, { postId: '10' }, { postId: '11' }
    ].map((p) => Object.assign(p, { content: 'x' })) };
    const out = WU.detectPositionLikeIds(data, SCHEMA);
    assert.ok(out && out.length === 1, 'flagged: ' + JSON.stringify(out));
    assert.equal(out[0].field, 'postId');
    assert.equal(out[0].count, 8);
    assert.ok(/aria-posinset|position|index|permalink/i.test(out[0].note), 'note names the mechanism and the fix');
  });

  it('real opaque ids (10+ digit) pass untouched', () => {
    const data = { posts: [
      { postId: '122135635131161282', content: 'a' }, { postId: '10231527832961990', content: 'b' },
      { postId: '1570896741710556', content: 'c' }
    ] };
    assert.equal(WU.detectPositionLikeIds(data, SCHEMA), null);
  });

  it('a minority of small values (mixed real ids) does not flag', () => {
    const data = { posts: [
      { postId: '122135635131161282', content: 'a' }, { postId: '10231527832961990', content: 'b' },
      { postId: '42', content: 'c' }, { postId: '1570896741710556', content: 'd' }
    ] };
    assert.equal(WU.detectPositionLikeIds(data, SCHEMA), null);
  });

  it('malformed input → null, never throws', () => {
    assert.equal(WU.detectPositionLikeIds(null, SCHEMA), null);
    assert.equal(WU.detectPositionLikeIds({ posts: [] }, null), null);
  });

  it('verify wiring: report-only POSITION_LIKE_ID tag on a green run', async () => {
    const data = { posts: [
      { postId: '3', content: 'a' }, { postId: '4', content: 'b' }, { postId: '5', content: 'c' }
    ] };
    const schema = { type: 'object', required: ['posts'], properties: { posts: { type: 'array', items: { type: 'object', required: ['postId'], properties: {
      postId: { type: 'string' }, content: { type: 'string' }
    } } } } };
    const runner = makeRunnerF2(async () => ({
      finalResult: data,
      steps: [{ stepId: 'extract', stepName: 'extract', result: { done: true } }],
      pages: []
    }));
    const out = await runner({ service: SERVICE_F2, input: {}, outputSchema: schema });
    assert.equal(out.report.ok, true, 'report-only');
    assert.ok(Array.isArray(out.report.detectors.positionLikeIds) && out.report.detectors.positionLikeIds.length === 1);
    assert.ok(out.report.events.includes('POSITION_LIKE_ID'), 'tags: ' + JSON.stringify(out.report.events));
  });

  it('knowledge unit position-like-id exists, keyed to the tag', () => {
    const u = KNOWLEDGE_UNITS.find((x) => x.id === 'position-like-id');
    assert.ok(u, 'unit exists');
    assert.ok(u.matchEvents.includes('POSITION_LIKE_ID'));
    assert.ok(/aria-posinset|position/i.test(u.body), 'names the position-attribute mechanism');
    assert.ok(/permalink|href/i.test(u.body), 'names where real ids live');
  });
});

function makeRunnerF2(orchestrateImpl) {
  const deps = {
    orchestrate: orchestrateImpl,
    ensureLock: async () => {},
    getSignal: () => null,
    log: () => {},
    onEvent: () => {},
    createTab: async (url) => ({ id: 11, url }),
    removeTab: async () => {},
    waitForTabLoad: async () => {},
    sendMessage: async () => ({ pong: true }),
    executeScript: async () => ({ result: 'ok', selectorDiagnostics: [] }),
    captureSnapshot: async () => ({ html: '<html></html>' }),
    evaluateCondition: async () => true
  };
  return createVerifyRunner(deps);
}
const SERVICE_F2 = { targetUrl: 'https://example.com', steps: [
  { id: 'extract', name: 'extract', script: 'return 1', onSuccess: 'TERMINATE' }
], config: {} };

// universality
describe('universality: fifty-fifth-log additions carry no site tokens', () => {
  const FORBIDDEN = /facebook|twitter|linkedin|tiktok|reddit|\bfb\b/i;
  it('new detector + unit stay generic', () => {
    const wuSrc = require('fs').readFileSync(require('path').join(__dirname, '../lib/wizard-utils.js'), 'utf8').replace(/\0/g, '');
    const i = wuSrc.indexOf('function detectPositionLikeIds');
    assert.ok(i > -1, 'detector present');
    assert.ok(!FORBIDDEN.test(wuSrc.slice(i, i + 2000)));
    const u = KNOWLEDGE_UNITS.find((x) => x.id === 'position-like-id');
    assert.ok(!FORBIDDEN.test(u.id + ' ' + u.title + ' ' + u.body + ' ' + u.matchEvents.join(' ')));
  });
});
