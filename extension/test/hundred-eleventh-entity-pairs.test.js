// 111th log: post1 ≡ post5 AGAIN (same content/postTime/counts/hovercard;
// postIds 'fbid=1572930034848815' vs 'pfbid02FKwo5Xiznuid18M' — the same
// card under two identifier surfaces). The model's own dedupe (by postId)
// cannot catch cross-surface duplicates, and verify's wholesale-ratio
// duplicate detector (threshold 1.0 over full-record signatures INCLUDING
// the id) structurally cannot: one differing field breaks the signature and
// a single pair is 2/5 = 0.4. The user has hit this class twice (107, 111).
// Fix: PAIRWISE entity-duplicate detection — records matching on EVERY
// comparable data field (≥3) with differing id surfaces are the same entity
// extracted twice; veto as DUPLICATE_ENTITY_PAIRS.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const WU = fs.readFileSync(path.join(__dirname, '..', 'lib', 'wizard-utils.js'), 'utf8');
const VR = fs.readFileSync(path.join(__dirname, '..', 'lib', 'verify-runner.js'), 'utf8');
const ED = fs.readFileSync(path.join(__dirname, '..', 'lib', 'evidence-dossier.js'), 'utf8');

function sliceFnFrom(src, name) {
  const start = src.indexOf('function ' + name + '(');
  assert.ok(start > -1, name + ' must be defined');
  let depth = 0, i = start;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') { depth -= 1; if (depth === 0) break; }
  }
  return src.slice(start, i + 1);
}

const SCHEMA = {
  type: 'object',
  properties: {
    posts: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          index: { type: 'number' },
          postId: { type: 'string' },
          postTime: { type: 'string' },
          content: { type: 'string' },
          likeCount: { type: 'string' },
          commentCount: { type: 'string' },
          shareCount: { type: 'string' },
          htmlSnippet: { type: 'string' }
        },
        required: ['index', 'postId', 'postTime', 'content']
      }
    }
  }
};

function loadPairs() {
  const helper = sliceFnFrom(WU, 'schemaArrayItemFieldKeys');
  const fnSrc = helper + '\n' + sliceFnFrom(WU, 'detectDuplicateEntityPairs') + '\nthis.__fn = detectDuplicateEntityPairs;';
  const ctx = {}; vm.createContext(ctx); vm.runInContext(fnSrc, ctx);
  return ctx.__fn;
}

describe('111st: detectDuplicateEntityPairs behavior', () => {
  const fn = loadPairs();
  it('the incident shape — same card, two id surfaces — is caught', () => {
    const data = { posts: [
      { index: 1, postId: 'fbid=1572930034848815', postTime: 'September 21, 2026 at 11:54 AM', content: 'ADVANCED AI post', likeCount: '117', commentCount: '1', shareCount: '57', htmlSnippet: '<a/>' },
      { index: 2, postId: 'fbid=1629679545353109', postTime: 'September 21, 2026 at 11:06 AM', content: 'other post', likeCount: '111', commentCount: '17', shareCount: '58', htmlSnippet: '<b/>' },
      { index: 5, postId: 'pfbid02FKwo5Xiznuid18M', postTime: 'September 21, 2026 at 11:54 AM', content: 'ADVANCED AI post', likeCount: '117', commentCount: '1', shareCount: '57', htmlSnippet: '<a/>' }
    ] };
    const r = fn(data, SCHEMA);
    assert.equal(r.length, 1, 'exactly the 1≡3 pair');
    assert.equal(r[0].indexA, 1);
    assert.equal(r[0].indexB, 3);
    assert.ok(r[0].matchedFields.indexOf('content') !== -1 && r[0].matchedFields.indexOf('postTime') !== -1);
    assert.ok(r[0].idSurface && r[0].idSurface.field === 'postId', 'the differing id surface is named');
  });
  it('a comparable data field differing kills the pair (reposts with same content but different time are NOT duplicates)', () => {
    const data = { posts: [
      { index: 1, postId: 'a', postTime: 'T1', content: 'same text', likeCount: '5', commentCount: '1', shareCount: '2' },
      { index: 2, postId: 'b', postTime: 'T2', content: 'same text', likeCount: '5', commentCount: '1', shareCount: '2' }
    ] };
    assert.equal(fn(data, SCHEMA).length, 0);
  });
  it('fewer than 3 comparable fields never flags (thin records)', () => {
    const data = { posts: [
      { index: 1, postId: 'a', postTime: 'T1' },
      { index: 2, postId: 'b', postTime: 'T1' }
    ] };
    assert.equal(fn(data, SCHEMA).length, 0);
  });
  it('ordinal fields (index) never block the match; empty fields are skipped, not compared', () => {
    const data = { posts: [
      { index: 1, postId: 'x1', postTime: 'T', content: 'c', likeCount: '1', commentCount: '', shareCount: '' },
      { index: 2, postId: 'x2', postTime: 'T', content: 'c', likeCount: '1', commentCount: null, shareCount: undefined }
    ] };
    const r = fn(data, SCHEMA);
    assert.equal(r.length, 1, 'matched on postTime+content+likeCount (3 comparables); empties skipped');
  });
});

describe('111st: verify veto + census + plain-language wiring (source audit)', () => {
  it('verify-runner vetoes DUPLICATE_ENTITY_PAIRS with dedupe teaching', () => {
    const i = VR.indexOf('DUPLICATE_ENTITY_PAIRS');
    assert.ok(i > -1, 'gate present');
    const block = VR.slice(i - 400, i + 600);
    assert.match(block, /detectDuplicateEntityPairs/, 'wired to the detector');
    assert.match(block, /entity signature|signature/, 'teaching names the entity-signature dedupe route');
  });
  it('evidence-dossier census renders the pairs row', () => {
    assert.match(ED, /duplicateEntityPairs/, 'census row present');
  });
  it('DETECTOR_PLAIN carries an action entry', () => {
    assert.match(WU, /duplicateEntityPairs:\s*\{\s*level:\s*'action'/, 'plain-language action entry');
  });
});
