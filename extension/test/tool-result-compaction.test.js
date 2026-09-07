// Thirty-second log root fix (RC-A): the LLM transcript path summarized every
// tool result with a FLAT HEAD-ONLY slice (summarizeToolResult: JSON-stringify
// the whole result, whitespace-flatten, cut at ~cap chars). The verify report's
// tail keys — detectors.partialEmptyFields, emptyFieldDiagnostics,
// steps[].resultPreview, finalResult — NEVER reached the model (29th-log
// timeMapSize class: head cuts destroy tail instrumentation), and one long
// error string ate the whole head budget. User directive: do not casually
// truncate requests to the LLM — clean and SELECT with structure-aware tools.
//
// compactToolResultForLLM keeps:
//   - every object KEY name alive (values may elide, names never vanish);
//   - long strings head+tail with a disclosed [+N chars elided] count;
//   - arrays first-N plus an item-count disclosure;
//   - a tight label cap — the model authored the args one message earlier,
//     echoing 1000+ chars of them burns the result's budget.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const Protocol = require(path.join(__dirname, '..', 'lib', 'session-protocol.js'));

describe('compactToolResultForLLM: small results pass through untouched', () => {
  it('a result that fits renders as label → compact JSON', () => {
    const s = Protocol.compactToolResultForLLM('probe.count {"sel":"div"}', { count: 5 }, 4000);
    assert.match(s, /^probe\.count \{"sel":"div"\} → /);
    assert.ok(s.includes('"count":5'));
    assert.ok(!s.includes('elided'), 'no elision markers when everything fits');
    assert.ok(s.length <= 4000);
  });

  it('non-serializable results degrade to String() instead of throwing', () => {
    const cyc = {};
    cyc.self = cyc;
    const s = Protocol.compactToolResultForLLM('t', cyc, 4000);
    assert.equal(typeof s, 'string');
    assert.ok(s.length > 3);
  });
});

describe('compactToolResultForLLM: long strings keep head AND tail with a disclosed count', () => {
  it('a huge flat string elides the middle, never the tail', () => {
    const big = 'H'.repeat(6000) + 'TAIL_MARKER_XYZ' + 'T'.repeat(100);
    const s = Protocol.compactToolResultForLLM('t', big, 1000);
    assert.ok(s.includes('TAIL_MARKER_XYZ'), 'the tail survives');
    assert.ok(s.includes('elided'), 'the elision is disclosed');
    assert.match(s, /\+\d+ chars? elided/);
    assert.ok(s.length <= 1100, 'respects the budget (marker slack only)');
  });

  it('the label is capped tight — the model authored the args one message ago', () => {
    const longLabel = 'service.update {"steps":[' + '"script":"x".repeat-consumes-budget",'.repeat(80) + ']}';
    const s = Protocol.compactToolResultForLLM(longLabel, { ok: true, artifactVersion: 9, notes: 'N'.repeat(600) }, 1000);
    const arrow = s.indexOf(' → ');
    assert.ok(arrow > -1 && arrow <= 200, 'label stays small so the result gets the budget');
    assert.ok(s.includes('"artifactVersion":9'), 'result keys survive a long-args label');
  });
});

describe('compactToolResultForLLM: objects keep every key name', () => {
  // The 32nd log's exact failure shape: a verify report whose tail keys
  // (detectors/steps/finalResult) never reached the model.
  const report = {
    executedArtifactVersion: 2,
    ok: false,
    error: { message: 'REQUIRED_FIELD_EMPTY: posts.postTime is empty in 9/9 records. ' + 'advice '.repeat(120) + 'read steps[].resultPreview before re-probing.' },
    aborted: false,
    score: { score: 193.2, isData: true },
    detectors: { emptyFields: [], partialEmptyFields: [{ path: 'posts.postTime', emptyCount: 9, totalCount: 9 }], emptyFieldDiagnostics: null },
    steps: [
      { stepId: 'extractPosts', ok: true, resultPreview: '{"posts":[{"index":1,"postTime":"","postId":"1221"}]}' },
      { stepId: 'scrollLoad', ok: true, resultPreview: '{"done":true,"count":9}' }
    ],
    finalResult: null,
    pages: '0'
  };

  it('head keys AND tail keys are all present under the 4000-char budget', () => {
    const s = Protocol.compactToolResultForLLM('verify.run {}', report, 4000);
    for (const key of ['executedArtifactVersion', 'error', 'detectors', 'steps', 'finalResult', 'pages']) {
      assert.ok(s.includes('"' + key + '"'), key + ' key name must survive');
    }
    assert.ok(s.length <= 4200, 'respects the budget');
  });

  it('a big string field elides alone — sibling keys keep their values intact', () => {
    const obj = {
      verdict: 'GREEN',
      htmlSnippet: 'x'.repeat(9000),
      postId: '122144750205134676'
    };
    const s = Protocol.compactToolResultForLLM('t', obj, 1500);
    assert.ok(s.includes('"verdict":"GREEN"'));
    assert.ok(s.includes('"postId":"122144750205134676"'));
    assert.ok(!s.includes('x'.repeat(1000)), 'the 9000-char string is elided');
    assert.match(s, /htmlSnippet/);
  });

  it('when the budget runs out mid-object, remaining key NAMES still list', () => {
    const obj = {};
    for (let i = 0; i < 30; i++) obj['field' + i] = 'v'.repeat(400);
    const s = Protocol.compactToolResultForLLM('t', obj, 2000);
    assert.ok(s.includes('field0'));
    assert.ok(s.includes('field'), 'key names appear as elided stubs');
    assert.ok(s.length <= 2200);
  });
});

describe('compactToolResultForLLM: arrays disclose their item count', () => {
  it('keeps the first items and discloses the rest by count', () => {
    const arr = [];
    for (let i = 0; i < 200; i++) arr.push({ index: i, content: 'post body text '.repeat(12) });
    const s = Protocol.compactToolResultForLLM('t', arr, 2000);
    assert.ok(s.includes('"index":0'), 'first element shape is visible');
    assert.match(s, /\+\d+ more items? elided/);
    assert.ok(s.length <= 2200);
  });

  it('nested arrays inside objects still disclose counts', () => {
    const obj = { posts: [], pages: '3' };
    for (let i = 0; i < 120; i++) obj.posts.push({ postId: 'p' + i, content: 'c'.repeat(300) });
    const s = Protocol.compactToolResultForLLM('t', obj, 1800);
    assert.ok(s.includes('"pages":"3"'), 'sibling key after the big array survives');
    assert.match(s, /more items? elided/);
  });
});
