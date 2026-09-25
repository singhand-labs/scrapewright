// extension/test/hundred-fifty-second-log-prefix-verdict.test.js
//
// 152nd log: the session shipped best-effort on a red final verify — v5 and
// v6 both died at DUPLICATE_ID_REQUIRED, and the 150th-log verdict pointed
// the WRONG way both times. The shared values were
//   v5: "https://www.facebook.com/photo/"     (literal URL prefix, 6/6 records)
//   v6: "https://www.facebook.com/profile.php" (literal URL prefix, records 3,6)
// — neither carries ANY per-record identifier segment (no id digits, no
// query tokens). The 150th-log DIFFERENT-content branch taught
// "album/carousel-scoped link — take the id from a per-record href", which
// describes a REAL shared link carrying an id (the 150th incident:
// /photo/?fbid=1222...&set=a...). The 152nd shape is different: the
// EXTRACTOR matched a constant URL prefix (a regex run over container
// markup), so no per-record href "beside it" exists at that binding at all —
// the fix is to bind the per-card link directly (attr:"href") instead of a
// match/regex capture. The model burned two artifact versions (6/6 then 2/6)
// against the wrong branch.
//
// Fix under test — three-way verdict, mechanically discriminable from the
// shared value alone:
//   value carries an id-shaped segment (>=4-digit run, id-bearing query, or
//   a long alnum token like pfbid...) → "scoped" → the 150th album/carousel
//   teaching stands;
//   value carries NO such segment → "prefix" → the prefix-capture teaching:
//   bind the per-card link attr directly, do not regex-capture a constant.
//
// No site tokens.
const { test, describe, it } = require('node:test');
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const WU = require('../lib/wizard-utils');
const VR_SRC = fs.readFileSync(path.join(__dirname, '..', 'lib', 'verify-runner.js'), 'utf8');

const SCHEMA = { type: 'object', required: ['posts'], properties: { posts: { type: 'array', items: { type: 'object',
  required: ['postId', 'content'],
  properties: { postId: { type: 'string' }, content: { type: 'string' } } } } } };

const mk = (pid, c) => ({ postId: pid, content: c });

describe('152nd log A — idValueShape: does the shared value carry an id at all', () => {
  it('the 152nd shapes (bare URL prefixes, no id segment) are PREFIX', () => {
    assert.equal(WU.idValueShape('https://www.facebook.com/photo/'), 'prefix', 'v5 incident value');
    assert.equal(WU.idValueShape('https://www.facebook.com/profile.php'), 'prefix', 'v6 incident value');
    assert.equal(WU.idValueShape('https://example.com'), 'prefix', 'a bare origin is a constant, not an id');
  });
  it('the 150th shape (a real shared link WITH an id segment) stays SCOPED', () => {
    assert.equal(WU.idValueShape('/photo/?fbid=122284781696149879&set=a.100'), 'scoped', '150th incident value — id-bearing query');
    assert.equal(WU.idValueShape('/photo/?fbid=9&set=a.1'), 'scoped', 'id-bearing QUERY KEYS (fbid/story_fbid/set/*id) count even with short test values');
    assert.equal(WU.idValueShape('/groups/1234567890/posts/998877665'), 'scoped', 'path digit runs');
    assert.equal(WU.idValueShape('122284781696149879'), 'scoped', 'a bare numeric id shared by records is a real (scoped) value');
    assert.equal(WU.idValueShape('/story/pfbid02xKc9AbCdEfGhIjKlMnOp'), 'scoped', 'long alnum tokens (pfbid) count as id-shaped');
  });
  it('tracking-only queries do not make a constant look scoped', () => {
    assert.equal(WU.idValueShape('https://example.com/?utm_source=feed'), 'prefix', 'a tracking-only query carries no record identity');
    assert.equal(WU.idValueShape('https://example.com/?ref=bookmarks'), 'prefix');
  });
});

describe('152nd log B — the id lane carries valueShape', () => {
  it('a duplicated PREFIX value gets valueShape prefix; a scoped value gets scoped', () => {
    const dups = WU.detectDuplicateIdValues({ posts: [
      mk('https://www.facebook.com/photo/', 'content alpha about machine learning'),
      mk('https://www.facebook.com/photo/', 'content beta about travel photography')
    ] }, SCHEMA);
    const lane = dups.find((d) => !d.kind && d.field === 'postId');
    assert.ok(lane, 'id lane present');
    assert.equal(lane.valueShape, 'prefix');
    assert.equal(lane.samplesDiffer, true);

    const dups2 = WU.detectDuplicateIdValues({ posts: [
      mk('/photo/?fbid=1222&set=a.1', 'content alpha about machine learning'),
      mk('/photo/?fbid=1222&set=a.1', 'content beta about travel photography')
    ] }, SCHEMA);
    const lane2 = dups2.find((d) => !d.kind && d.field === 'postId');
    assert.ok(lane2);
    assert.equal(lane2.valueShape, 'scoped');
  });
});

describe('152nd log C — the veto renders the prefix-capture branch (behavioral)', () => {
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

  it('DIFFERENT contents + PREFIX value: teaches the direct href binding, NOT album-scoped', async () => {
    const orch = async (svc, input, d, opts) => {
      await d.createTab(svc.targetUrl);
      opts.onEvent({ type: 'EXECUTION_START' });
      opts.onEvent({ type: 'STEP_ITERATION', stepId: 's1', iteration: 1, resultPreview: '{"done":true}' });
      return { finalResult: { posts: [
        mk('https://www.facebook.com/photo/', 'content alpha about machine learning'),
        mk('https://www.facebook.com/photo/', 'content beta about travel photography')
      ] }, steps: [], pages: [], pagesTruncated: false };
    };
    const out = await makeRunner(orch)({ service: { targetUrl: 'https://e.com', steps: [{ id: 's1', name: 'x', script: 'return 1', onSuccess: 'TERMINATE' }], config: {} }, input: {}, outputSchema: SCHEMA });
    assert.equal(out.report.ok, false);
    assert.match(out.report.error.message, /DUPLICATE_ID_REQUIRED/);
    assert.match(out.report.error.message, /Record samples: #1 /);
    assert.match(out.report.error.message, /constant URL prefix/i, 'names the extractor fault');
    assert.match(out.report.error.message, /attr:\s*'href'|attr:\s*"href"/, 'the fix route: bind the per-card link attribute directly');
    assert.doesNotMatch(out.report.error.message, /album\/carousel-scoped/, 'the wrong branch must NOT fire for a value with no id segment');
  });

  it('DIFFERENT contents + SCOPED value: the 150th album-scoped branch still fires (regression pin)', async () => {
    const orch = async (svc, input, d, opts) => {
      await d.createTab(svc.targetUrl);
      opts.onEvent({ type: 'EXECUTION_START' });
      opts.onEvent({ type: 'STEP_ITERATION', stepId: 's1', iteration: 1, resultPreview: '{"done":true}' });
      return { finalResult: { posts: [
        mk('/photo/?fbid=91011&set=a.1', 'content alpha about machine learning'),
        mk('/photo/?fbid=91011&set=a.1', 'content beta about travel photography')
      ] }, steps: [], pages: [], pagesTruncated: false };
    };
    const out = await makeRunner(orch)({ service: { targetUrl: 'https://e.com', steps: [{ id: 's1', name: 'x', script: 'return 1', onSuccess: 'TERMINATE' }], config: {} }, input: {}, outputSchema: SCHEMA });
    assert.equal(out.report.ok, false);
    assert.match(out.report.error.message, /album\/carousel-scoped/);
    assert.doesNotMatch(out.report.error.message, /constant URL prefix/i);
  });
});

describe('152nd log D — veto source audit: the differ branch is a three-way', () => {
  it('valueShape drives the split inside the samplesDiffer branch', () => {
    const i = VR_SRC.indexOf('let dupSamplesLine');
    const region = VR_SRC.slice(i, i + 3600);
    assert.match(region, /valueShape/, 'the shape check is present');
    assert.match(region, /constant URL prefix/i, 'prefix branch text present');
    assert.match(region, /album\/carousel-scoped/, 'scoped branch text preserved');
    assert.match(region, /deduplicate by the entity signature/, 'SAME branch preserved');
  });
});
