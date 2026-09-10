// extension/test/fifty-eighth-log-followups.test.js
// Fifty-eighth log — glm-5.1, 25 turns, ONE recovered protocol violation,
// completed with a GREEN v3 verify on the logged-out /search/posts page (the
// model even argued the story_marker polarity correctly with count
// differentials). The 55th-round disclosure ladder rode the finish (RELATIVE-
// TIMESTAMPS + JUNK-VALUES). Three residual gaps:
//  F1 probe.timestamp sat in the bag UNUSED — postTime went 3/3 empty →
//     hand-rolled labelledby → BOTH shipped values relative ("a day ago"/
//     "4 days ago"); the knowledge units that auto-attach on the very tags
//     this verify raised still teach the OLD multi-probe dance.
//  F2 likes shipped as "Like: 37 people" — the count is RIGHT THERE,
//     parseable; no census names the label-prefixed-count shape.
//  F3 the finish printed "posts.hovercards.link, posts.hovercards.link" —
//     the junk-field disclosure list does not dedupe.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createResearchSession } = require('../lib/research-session');
const { createVerifyRunner } = require('../lib/verify-runner');
const WU = require('../lib/wizard-utils');
const { KNOWLEDGE_UNITS } = require('../lib/knowledge-units');

// ---------------------------------------------------------------------------
// F1: knowledge units route to the one-call tool
describe('F1: time units lead with probe.timestamp (fifty-eighth log)', () => {
  it('relative-timestamp-rebind names the one-call probe as the first move', () => {
    const u = KNOWLEDGE_UNITS.find((x) => x.id === 'relative-timestamp-rebind');
    assert.ok(u, 'unit exists');
    assert.match(u.body, /probe\.timestamp/, 'routes to the tool');
    const i = u.body.indexOf('probe.timestamp');
    assert.ok(i >= 0 && i < u.body.indexOf('.') + 400, 'named early (the first-move position)');
  });

  it('time-field-implausible names it too', () => {
    const u = KNOWLEDGE_UNITS.find((x) => x.id === 'time-field-implausible');
    assert.ok(u);
    assert.match(u.body, /probe\.timestamp/);
  });
});

// ---------------------------------------------------------------------------
// F2: label-prefixed count census
describe('F2: detectLabelPrefixedCounts (fifty-eighth log)', () => {
  const SCHEMA = { type: 'object', required: ['posts'], properties: { posts: { type: 'array', items: { type: 'object', properties: {
    likes: { type: 'string' }, comments: { type: 'string' }, content: { type: 'string' }
  } } } } };

  it('flags "Like: 37 people" with the parsed count — the number is right there', () => {
    const data = { posts: [
      { likes: 'Like: 37 people', comments: '', content: 'a' },
      { likes: 'Like: 220 people', comments: '', content: 'b' }
    ] };
    const out = WU.detectLabelPrefixedCounts(data, SCHEMA);
    assert.ok(out && out.length === 1, 'flagged: ' + JSON.stringify(out));
    assert.equal(out[0].field, 'likes');
    assert.equal(out[0].parsedSample, '37', 'carries the parseable count');
    assert.ok(/match|parse|regex/i.test(out[0].note), 'note teaches the parse');
  });

  it('clean numeric counts, empties, and non-countish fields pass untouched', () => {
    const data = { posts: [
      { likes: '37', comments: '12', content: 'Section 2 of the report' },
      { likes: '2.4K', comments: '', content: 'Chapter 7 part 1' }
    ] };
    assert.equal(WU.detectLabelPrefixedCounts(data, SCHEMA), null);
  });

  it('malformed input → null, never throws', () => {
    assert.equal(WU.detectLabelPrefixedCounts(null, SCHEMA), null);
    assert.equal(WU.detectLabelPrefixedCounts({ posts: [] }, null), null);
  });

  it('verify wiring: report-only LABEL_PREFIXED_COUNT tag on a green run', async () => {
    const data = { posts: [
      { likes: 'Like: 37 people', content: 'a' },
      { likes: 'Like: 9 people', content: 'b' }
    ] };
    const schema = { type: 'object', required: ['posts'], properties: { posts: { type: 'array', items: { type: 'object', required: ['content'], properties: {
      likes: { type: 'string' }, content: { type: 'string' }
    } } } } };
    const runner = makeRunner58(async () => ({
      finalResult: data,
      steps: [{ stepId: 'extract', stepName: 'extract', result: { done: true } }],
      pages: []
    }));
    const out = await runner({ service: SERVICE58, input: {}, outputSchema: schema });
    assert.equal(out.report.ok, true, 'report-only');
    assert.ok(Array.isArray(out.report.detectors.labelPrefixedCounts) && out.report.detectors.labelPrefixedCounts.length === 1);
    assert.ok(out.report.events.includes('LABEL_PREFIXED_COUNT'), 'tags: ' + JSON.stringify(out.report.events));
  });
});

// ---------------------------------------------------------------------------
// F3: junk-field disclosure dedupe
describe('F3: junk disclosure dedupes repeated fields (fifty-eighth log)', () => {
  it('two census entries for the SAME field print once in the finish disclosure', async () => {
    const session = createResearchSession({
      requirement: 'collect posts',
      llm: scriptedLlm58([
        { content: JSON.stringify({ think: 't', tool: 'verify.run', args: {} }), finish_reason: 'stop', usage: { prompt_tokens: 10, completion_tokens: 5 } },
        { content: JSON.stringify({ think: 'done', finish: { summary: 'shipped v3' } }), finish_reason: 'stop', usage: { prompt_tokens: 10, completion_tokens: 5 } }
      ], []),
      tools: { 'verify.run': async () => ({
        ok: true, error: null, aborted: false, score: { score: 124, isData: true, breakdown: {} },
        schemaOk: true, schemaMissing: [],
        detectors: { emptyFields: [], duplicateFields: [], countShortfall: null, partialEmptyFields: [],
          junkValues: { fields: [
            { field: 'posts.hovercards.link', kind: 'queryBlob', count: 4, sample: '?__cft__…' },
            { field: 'posts.hovercards.link', kind: 'opaqueToken', count: 2, sample: 'x' },
            { field: 'posts.permalink', kind: 'queryBlob', count: 2, sample: '?q=' }
          ] } },
        steps: [], finalResult: { posts: [{}] }, pages: '1', eventCount: 3, events: []
      }) }
    });
    const report = await session.run();
    assert.equal(report.stopped.reason, 'completed');
    const m = report.stopped.detail.match(/JUNK-VALUES[^\]]*\]/);
    assert.ok(m, 'junk disclosure present');
    const listing = m[0];
    const occurrences = listing.split('posts.hovercards.link').length - 1;
    assert.equal(occurrences, 1, 'the duplicated field prints exactly once: ' + listing);
    assert.ok(listing.includes('posts.permalink'), 'other junk fields still listed');
  });
});

function scriptedLlm58(replies, calls) {
  let i = 0;
  return async (req) => {
    calls.push(req);
    const r = replies[Math.min(i, replies.length - 1)];
    i++;
    return r;
  };
}
function makeRunner58(orchestrateImpl) {
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
const SERVICE58 = { targetUrl: 'https://example.com', steps: [
  { id: 'extract', name: 'extract', script: 'return 1', onSuccess: 'TERMINATE' }
], config: {} };

// universality
describe('universality: fifty-eighth-log additions carry no site tokens', () => {
  const FORBIDDEN = /facebook|twitter|linkedin|tiktok|reddit|\bfb\b/i;
  it('the new detector + edited units stay generic', () => {
    const fs = require('fs');
    const src = fs.readFileSync(require('path').join(__dirname, '../lib/wizard-utils.js'), 'utf8').replace(/\0/g, '');
    const i = src.indexOf('function detectLabelPrefixedCounts');
    assert.ok(i > -1, 'detector present');
    assert.ok(!FORBIDDEN.test(src.slice(i, i + 1800)));
    for (const id of ['relative-timestamp-rebind', 'time-field-implausible']) {
      const u = KNOWLEDGE_UNITS.find((x) => x.id === id);
      assert.ok(!FORBIDDEN.test(u.body), id + ' generic after edit');
    }
  });
});
