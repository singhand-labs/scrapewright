// extension/test/hundred-fiftieth-log-dup-samples.test.js
//
// 150th log: the session burned 80 turns against three consecutive
// DUPLICATE_ID_REQUIRED reds (v4 3/3, v6 3/4, v7 3/4 — the same
// album-scoped /photo/?fbid=... link on different posts posing as postId).
// The model's decisive question — "same post extracted twice, or DIFFERENT
// posts sharing one link?" — took it ~40 turns to answer from probing; the
// detector can answer it mechanically at detection time from the records'
// own content.
//
// Fix under test: detectDuplicateIdValues' id lane carries per-record
// recordSamples + the samplesDiffer verdict, and the verify-side
// DUPLICATE_ID_REQUIRED veto renders them with branch-specific teaching —
// DIFFERENT samples → the shared value is album/carousel-scoped, take the
// id from a per-record href; SAME samples → dedupe by entity signature.
//
// No site tokens.
const { test, describe, it } = require('node:test');
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');

const WU = require('../lib/wizard-utils');
const VR_SRC = fs.readFileSync(path.join(__dirname, '..', 'lib', 'verify-runner.js'), 'utf8');

const SCHEMA = { type: 'object', required: ['posts'], properties: { posts: { type: 'array', items: { type: 'object',
  required: ['postId', 'content'],
  properties: { postId: { type: 'string' }, content: { type: 'string' } } } } } };

const mk = (pid, c) => ({ postId: pid, content: c });

describe('150th log — duplicate-id record samples', () => {
  it('DIFFERENT contents sharing one link: samplesDiffer true + per-record hints', () => {
    const dups = WU.detectDuplicateIdValues({ posts: [
      mk('/photo/?fbid=1222&set=a.1', 'AI 社團 發布的機器學習文章第一篇'),
      mk('/posts/pfbid0UNIQUE', 'a distinct middle record with its own id'),
      mk('/photo/?fbid=1222&set=a.1', '攝影師分享的旅遊相簿，內容完全不同'),
      mk('/photo/?fbid=1222&set=a.1', 'third distinct post again shares the album link')
    ] }, SCHEMA);
    const idLane = dups.find((d) => !d.kind && d.field === 'postId');
    assert.ok(idLane, 'id lane present');
    assert.equal(idLane.count, 3);
    assert.equal(idLane.samplesDiffer, true, 'different contents → differ verdict');
    assert.ok(idLane.recordSamples.length >= 3, 'per-record samples');
    assert.equal(idLane.recordSamples[0].record, 1);
    assert.match(idLane.recordSamples[0].hint, /AI 社團/);
    assert.ok(idLane.recordSamples.some((x) => /攝影師/.test(x.hint)), 'each duplicated record\'s own hint rides along');
  });

  it('SAME content duplicated: samplesDiffer false', () => {
    const dups = WU.detectDuplicateIdValues({ posts: [
      mk('/posts/pfbid0SAME', 'identical duplicated post content here'),
      mk('/posts/pfbid0SAME', 'identical duplicated post content here')
    ] }, SCHEMA);
    const idLane = dups.find((d) => !d.kind && d.field === 'postId');
    assert.ok(idLane);
    assert.equal(idLane.samplesDiffer, false, 'identical samples → same verdict');
  });

  it('the veto renders the samples with branch-specific teaching (source audit)', () => {
    const i = VR_SRC.indexOf('let dupSamplesLine');
    const region = VR_SRC.slice(i, i + 2600);
    assert.match(region, /recordSamples/, 'samples rendered');
    assert.match(region, /album\/carousel-scoped/, 'DIFFERENT branch names the scope trap');
    assert.match(region, /per-record href \(a permalink \/posts\//, 'the fix route is named');
    assert.match(region, /deduplicate by the entity signature/, 'SAME branch teaches signature dedupe');
    assert.ok(region.indexOf('samplesDiffer') !== -1, 'the verdict drives the branch');
  });
});

describe('150th log — veto behavioral (differential rendering)', () => {
  // Reuse the 142nd-round vm harness for detectJunkValues? Simpler: assert
  // through the full verify runner like the 145th test does.
  const { createVerifyRunner } = require('../lib/verify-runner');

  function makeRunner(orch) {
    return createVerifyRunner({
      ensureLock: async () => {},
      releaseLock: async () => {},
      createTab: async () => ({ id: 1 }),
      removeTab: async () => {},
      waitForTabLoad: async () => {},
      sendMessage: async () => ({ pong: true }),
      executeScript: async () => ({ result: 'ok', selectorDiagnostics: [] }),
      captureSnapshot: async () => ({ html: '<html></html>' }),
      evaluateCondition: async () => true,
      orchestrate: orch
    });
  }

  it('a required duplicated postId with DIFFERENT contents renders the album-scoped branch', async () => {
    const orch = async (svc, input, d, opts) => {
      await d.createTab(svc.targetUrl);
      opts.onEvent({ type: 'EXECUTION_START' });
      opts.onEvent({ type: 'STEP_ITERATION', stepId: 's1', iteration: 1, resultPreview: '{"done":true}' });
      return { finalResult: { posts: [
        mk('/photo/?fbid=9&set=a.1', 'content alpha about machine learning'),
        mk('/photo/?fbid=9&set=a.1', 'content beta about travel photography')
      ] }, steps: [], pages: [], pagesTruncated: false };
    };
    const out = await makeRunner(orch)({ service: { targetUrl: 'https://e.com', steps: [{ id: 's1', name: 'x', script: 'return 1', onSuccess: 'TERMINATE' }], config: {} }, input: {}, outputSchema: SCHEMA });
    assert.equal(out.report.ok, false);
    assert.match(out.report.error.message, /DUPLICATE_ID_REQUIRED/);
    assert.match(out.report.error.message, /Record samples: #1 /);
    assert.match(out.report.error.message, /DIFFERENT content .* album\/carousel-scoped/);
    assert.match(out.report.error.message, /per-record href/);
  });

  // NOTE: a FULLY identical duplicate (id + content) never reaches the ID
  // veto — the older DUPLICATE_ENTITIES gate fires first with its own
  // nested-container teaching, which is the correct outcome for that shape.
  // The ID veto's same-samples branch is depth for partial overlap; the
  // differ-branch behavioral test above covers the incident shape.
});
