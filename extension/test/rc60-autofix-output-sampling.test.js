// RC60: autoFix prompt output-context diet (console.log 2026-08-18 12:36-12:45).
//
// RC59 got the run down from 10 rounds to 3 and the history into digests, but
// each round's prompt still measured ~504K chars (235-293K prompt tokens,
// rounds 1-2 with cached_tokens:0). Code-reconstructed composition (log lines
// truncate at ~9.4K): SCRIPT_DSL_GUIDE 60.8K + Current output ~250-300K +
// RUNTIME DIAGNOSTICS ~40-60K (capped) + steps/html ~50K. The dominant term
// is the serialized testResult:
//
// 1. RECORD MULTIPLICATION — the output schema legitimately carries an html
//    fragment per record plus per-record enrichment entries with html of
//    their own; every string is capped at 5K by stripSnapshotsFromTestResult,
//    but ~10 records × several capped fields multiply to ~250K of near-identical
//    markup. The LLM needs structure + empty-patterns + a few full examples —
//    the shape distribution signal already summarizes cross-record variance
//    (it reads the RAW testResult, not this serialization).
//
// 2. PREDECESSOR DUPLICATION — the extraction step's result (records BEFORE
//    enrichment) is a strict subset of finalResult (records AFTER enrichment).
//    RC59's elideDuplicateFinalResults only catches deep-equal results, so the
//    pre-enrichment copy was serialized in full next to the final one.
//
// 3. trimLlmHistory FLOOR (live evidence: round 3 = 4 messages, 176,469 chars
//    > the 150K cap, `length > 4` floor prevented any trimming).
//
// 4. User-directed: hover no-signal early-exit relaxed 1500→3000ms for
//    robustness (slow-mounting hovercards); the polling default timeout rises
//    3000→4500ms so the early-exit branch stays reachable (at threshold ==
//    timeout it would be dead code) and no-signal anchors stay capped at 3s.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const {
  sampleRecordsForLLMContext,
  elideDuplicateFinalResults
} = require('../lib/wizard-utils');

const readSrc = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

describe('RC60: sampleRecordsForLLMContext', () => {
  const makePosts = (n) => Array.from({ length: n }, (_, i) => ({
    index: i + 1,
    content: '正文' + i,
    html: '<div>' + 'x'.repeat(4000) + '</div>',
    hoverInfos: [{ htmlSnippet: '<span>' + 'y'.repeat(3000) + '</span>' }]
  }));

  it('keeps the first 3 records of a long record array and marks the rest omitted', () => {
    const out = sampleRecordsForLLMContext({ finalResult: { posts: makePosts(10) } });
    const posts = out.finalResult.posts;
    assert.equal(posts.length, 4, '3 kept records + 1 marker element, got ' + posts.length);
    assert.equal(posts[0].index, 1);
    assert.equal(posts[2].index, 3);
    const marker = posts[3];
    assert.ok(typeof marker === 'string' && /\+7 more records omitted/.test(marker),
      'marker must disclose 7 omitted records, got: ' + JSON.stringify(marker));
    assert.match(marker, /context budget/);
  });

  it('leaves short arrays (<= keep limit) untouched with no marker', () => {
    const three = makePosts(3);
    const out = sampleRecordsForLLMContext({ finalResult: { posts: three } });
    assert.deepEqual(out.finalResult.posts, three);
    assert.ok(!JSON.stringify(out).includes('omitted'));
  });

  it('samples nested record arrays inside kept records too', () => {
    const posts = makePosts(2).map(p => ({
      ...p,
      hoverInfos: Array.from({ length: 5 }, (_, i) => ({ htmlSnippet: 's' + i }))
    }));
    const out = sampleRecordsForLLMContext({ finalResult: { posts } });
    const nested = out.finalResult.posts[0].hoverInfos;
    assert.equal(nested.length, 4, 'nested arrays sample to 3 + marker, got ' + nested.length);
    assert.ok(/\+2 more records omitted/.test(String(nested[3])));
  });

  it('caps long primitive arrays (accumulator signature lists) at 20 + marker', () => {
    const out = sampleRecordsForLLMContext({
      finalResult: { seenSignatures: Array.from({ length: 100 }, (_, i) => 'sig' + i) }
    });
    const arr = out.finalResult.seenSignatures;
    assert.equal(arr.length, 21, '20 kept + marker, got ' + arr.length);
    assert.equal(arr[0], 'sig0');
    assert.equal(arr[19], 'sig19');
    assert.ok(/\+80 more items omitted/.test(String(arr[20])),
      'primitive marker must disclose 80 omitted items');
  });

  it('does NOT sample the top-level steps array itself (one entry per step is trace data, not records)', () => {
    const steps = Array.from({ length: 6 }, (_, i) => ({
      stepId: String(i + 1),
      result: { posts: makePosts(10) }
    }));
    const out = sampleRecordsForLLMContext({ steps, finalResult: { posts: makePosts(10) } });
    assert.equal(out.steps.length, 6,
      'every step entry must survive sampling, got ' + out.steps.length);
    assert.deepEqual(out.steps.map(s => s.stepId), ['1', '2', '3', '4', '5', '6']);
    // ...but step results ARE sampled inside each surviving entry
    assert.equal(out.steps[0].result.posts.length, 4, 'inner record arrays still sampled');
  });

  it('does not mutate the input testResult', () => {
    const testResult = { finalResult: { posts: makePosts(10) } };
    sampleRecordsForLLMContext(testResult);
    assert.equal(testResult.finalResult.posts.length, 10,
      'stored wizardState.testResult must stay untouched');
  });

  it('round-trips through JSON (marker elements are plain strings)', () => {
    const out = sampleRecordsForLLMContext({ finalResult: { posts: makePosts(5) } });
    assert.doesNotThrow(() => JSON.stringify(out));
  });
});

describe('RC60: elideDuplicateFinalResults predecessor elision', () => {
  const PREDECESSOR = /elided[^\n]*earlier-stage|earlier-stage[^\n]*finalResult/;

  it('elides a step result that is a subset of finalResult (pre-enrichment stage)', () => {
    // Incident shape: extraction step returns records; a later step enriches
    // each record (adds a key) and that enriched version becomes finalResult.
    const before = [{ id: 1, content: 'a' }, { id: 2, content: 'b' }];
    const after = before.map(r => ({ ...r, enrichment: [{ kind: 'extra', html: '<i>x</i>' }] }));
    const testResult = {
      finalResult: { posts: after },
      steps: [
        { stepId: '2', result: { done: true, uniqueCount: 7, seenSignatures: ['s1'] } },
        { stepId: '4', result: { posts: before } }
      ]
    };
    const out = elideDuplicateFinalResults(testResult);
    assert.deepEqual(out.steps[0].result, { done: true, uniqueCount: 7, seenSignatures: ['s1'] },
      'scroll-state result with no overlap in finalResult stays verbatim');
    assert.ok(PREDECESSOR.test(String(out.steps[1].result)),
      'pre-enrichment record set replaced by marker, got: ' + JSON.stringify(out.steps[1].result));
    assert.deepEqual(out.finalResult, { posts: after },
      'finalResult itself stays full');
  });

  it('tolerates per-record drift (>= 80% of records still subsets) — expanded content must not defeat elision', () => {
    const before = Array.from({ length: 10 }, (_, i) => ({ id: i, content: 'c' + i }));
    // 9 of 10 unchanged + enriched; 1 record's content mutated downstream.
    const after = before.map((r, i) => i === 5
      ? { ...r, content: 'EXPANDED ' + r.content, enrichment: [] }
      : { ...r, enrichment: [] });
    const testResult = {
      finalResult: { posts: after },
      steps: [{ stepId: '4', result: { posts: before } }]
    };
    const out = elideDuplicateFinalResults(testResult);
    assert.ok(PREDECESSOR.test(String(out.steps[0].result)),
      '9/10 subset match should still elide, got: ' + JSON.stringify(out.steps[0].result).slice(0, 120));
  });

  it('keeps a step result whose fields diverge from finalResult (below threshold)', () => {
    const before = Array.from({ length: 10 }, (_, i) => ({ id: i, content: 'c' + i }));
    const after = Array.from({ length: 10 }, (_, i) => ({ id: i, content: 'REWRITTEN ' + i }));
    const testResult = {
      finalResult: { posts: after },
      steps: [{ stepId: '4', result: { posts: before } }]
    };
    const out = elideDuplicateFinalResults(testResult);
    assert.deepEqual(out.steps[0].result, { posts: before },
      'only ids match — content diverged everywhere; the earlier stage carries independent signal');
  });

  it('keeps a step result whose array length differs from finalResult', () => {
    const before = [{ id: 1 }, { id: 2 }, { id: 3 }];
    const after = [{ id: 1 }, { id: 2 }];
    const testResult = {
      finalResult: { posts: after },
      steps: [{ stepId: '4', result: { posts: before } }]
    };
    const out = elideDuplicateFinalResults(testResult);
    assert.deepEqual(out.steps[0].result, { posts: before },
      'length change means the step is not a pure earlier stage (records were dropped/merged)');
  });
});

describe('RC60: wizard.js wiring (source-text)', () => {
  it('both serialization sites wrap the chain with sampleRecordsForLLMContext', () => {
    const src = readSrc('wizard.js');
    const count = (src.match(/sampleRecordsForLLMContext\(elideDuplicateFinalResults\(/g) || []).length;
    assert.ok(count >= 2,
      'testResultSection + currentOutput must both sample after elision; found ' + count);
  });

  it('trimLlmHistory floor is 2 (last user/assistant pair), not 4', () => {
    // Live evidence 2026-08-18: round-3 history = 4 messages / 176,469 chars
    // over the 150K cap, and `length > 4` blocked every trim attempt.
    const src = readSrc('wizard.js');
    const fnStart = src.indexOf('function trimLlmHistory');
    const fnEnd = src.indexOf('\nfunction ', fnStart + 1);
    const fnBody = src.slice(fnStart, fnEnd > fnStart ? fnEnd : undefined)
      .replace(/\/\/[^\n]*\n/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
    assert.match(fnBody, /history\.length > 2|llmHistory\.length > 2/,
      'floor must allow trimming down to the last pair');
    assert.doesNotMatch(fnBody, /length > 4/,
      'the 4-message floor that defeated the 150K cap must be gone');
  });

  it('sampleRecordsForLLMContext is exported from wizard-utils', () => {
    const src = readSrc('lib/wizard-utils.js');
    assert.match(src, /function sampleRecordsForLLMContext\(/);
    assert.match(src, /module\.exports[^\n]*sampleRecordsForLLMContext/);
  });
});

describe('RC60: hover no-signal early-exit relaxed to 3000ms (user decision)', () => {
  const sliceDomHover = () => {
    const src = readSrc('content-script.js');
    const start = src.indexOf('async function domHover(');
    const end = src.indexOf('async function domOpenTab(', start);
    assert.ok(start > -1 && end > start, 'domHover must be sliceable');
    return src.slice(start, end);
  };

  it('NO_SIGNAL_EARLY_EXIT_MS is 3000 (robustness over speed on no-hovercard anchors)', () => {
    const body = sliceDomHover();
    const m = body.match(/NO_SIGNAL_EARLY_EXIT_MS\s*=\s*(\d+)/);
    assert.ok(m, 'constant must be declared');
    assert.equal(parseInt(m[1], 10), 3000);
  });

  it('default polling timeout is raised above the threshold so the early-exit branch stays live', () => {
    // At threshold == default timeout the `dwellMs > NO_SIGNAL_EARLY_EXIT_MS`
    // branch could never fire before the loop's own deadline — dead code and
    // the named no_hover_signal_early_exit reason would silently vanish.
    const body = sliceDomHover();
    const threshold = parseInt(body.match(/NO_SIGNAL_EARLY_EXIT_MS\s*=\s*(\d+)/)[1], 10);
    const defaultMs = parseInt(
      body.match(/opts\.timeoutMs\s*===\s*'number'[^\n]*\?\s*opts\.timeoutMs\s*:\s*(\d+)/)[1], 10);
    assert.ok(defaultMs > threshold,
      'default timeout (' + defaultMs + 'ms) must exceed the early-exit threshold (' + threshold + 'ms)');
    assert.equal(defaultMs, 4500);
  });
});

describe('RC60: universality — no site-specific terms', () => {
  const SITE_NAMES = ['facebook', 'twitter', 'linkedin', 'tiktok', 'reddit',
    'instagram', 'weibo', 'zhihu', 'douyin'];
  const SITE_ABBREV = ['fb', 'ig'];
  const FORBIDDEN = new RegExp(
    '\\b(' + SITE_NAMES.join('|') + ')\\b|\\b(' + SITE_ABBREV.join('|') + ')\\b',
    'gi'
  );

  it('this test file has no site-specific prose beyond the universality guard itself', () => {
    const self = fs.readFileSync(__filename, 'utf8');
    const stripped = self
      .replace(/const SITE_NAMES[\s\S]*?;/, '')
      .replace(/const SITE_ABBREV[\s\S]*?;/, '')
      .replace(/const FORBIDDEN[\s\S]*?;/, '');
    const matches = stripped.match(FORBIDDEN) || [];
    assert.deepEqual(matches, [],
      'Found: ' + JSON.stringify(matches));
  });

  it('new wizard-utils markers carry no site terms', () => {
    const src = readSrc('lib/wizard-utils.js');
    const markers = [
      src.match(/\[\+\$\{[^}]+\} more records omitted[^`"']*/),
      src.match(/elided — earlier-stage[^`"']*/)
    ].filter(Boolean).map(m => m[0]);
    for (const marker of markers) {
      assert.deepEqual(marker.match(FORBIDDEN) || [], [],
        'marker must stay generic: ' + marker);
    }
  });
});
