// 110th log — user: "comments shares 都是空，反馈了也没修复". The rebuilt
// search service concluded "the page never renders comments/shares" from ONE
// cold-tab aria sweep, while the PRIOR same-site service (rounds 104/106) had
// extracted commentCount=9 / shareCount=1 — the contradiction lived in the
// execution history and never reached the model. Two fixes:
//   A. collectFieldSamplesFromOutput — mine per-field non-empty samples from
//      a past execution output; the ledger seed cites them so an absence
//      claim for a field the site already yielded reads as a contradiction.
//   B. the USER FEEDBACK injection teaches the named-field absence protocol
//      (warm tab / user.observe / same-site samples — a cold-tab sweep never
//      closes a named-field complaint).

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:path');
const P = require('node:path');
const vm = require('node:vm');
const WU_SRC = require('node:fs').readFileSync(P.join(__dirname, '..', 'lib', 'wizard-utils.js'), 'utf8');
const WJ_SRC = require('node:fs').readFileSync(P.join(__dirname, '..', 'wizard.js'), 'utf8');

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

describe('110th-A: collectFieldSamplesFromOutput mines prior-execution field samples', () => {
  const fnSrc = sliceFnFrom(WU_SRC, 'collectFieldSamplesFromOutput') + '\nthis.__fn = collectFieldSamplesFromOutput;';
  const ctx = {}; vm.createContext(ctx); vm.runInContext(fnSrc, ctx);
  const fn = ctx.__fn;
  it('finds record arrays through API/testResult envelopes and collects leaf samples', () => {
    const out = {
      testResult: {
        finalResult: {
          posts: [
            { postId: '111', commentCount: 9, shareCount: 1, content: 'hello world' },
            { postId: '222', commentCount: 62, shareCount: 8, content: 'second post here' }
          ]
        }
      }
    };
    const s = fn(out);
    assert.deepEqual([...s.commentCount], [9, 62]);
    assert.deepEqual([...s.shareCount], [1, 8]);
    assert.ok(s.postId.length === 2 && s.postId[0] === '111');
  });
  it('long strings are sliced, empties skipped, nested record arrays recursed', () => {
    const out = { posts: [{ id: 1, note: 'x'.repeat(100), kids: [{ k: 'a' }, { k: 'b' }] }] };
    // single record does not form a record array (needs ≥2) — but the OUTER
    // posts array is single-element too; verify graceful emptiness.
    const s1 = fn(out);
    assert.ok(!s1.kids, 'a 2-element nested array inside a non-record outer is still walked? — outer length 1 is not a record array, so nothing collects');
    const out2 = { posts: [{ id: 1, kids: [{ k: 'a' }, { k: 'b' }] }, { id: 2, kids: [{ k: 'c' }, { k: 'd' }] }] };
    const s2 = fn(out2);
    assert.deepEqual([...s2.k], ['a', 'b', 'c'], 'nested record arrays sampled, capped at 3');
    const out3 = { posts: [{ t: 'y'.repeat(100) }, { t: 'z'.repeat(100) }] };
    const s3 = fn(out3);
    assert.ok(String(s3.t[0]).length <= 41 && /…$/.test(s3.t[0]), 'long strings sliced with ellipsis');
  });
  it('non-object / garbage inputs return {} instead of throwing', () => {
    assert.equal(Object.keys(fn(null)).length, 0);
    assert.equal(Object.keys(fn('string')).length, 0);
    assert.equal(Object.keys(fn({ no: 'arrays' })).length, 0);
  });
});

describe('110th-B: wizard wiring (source audit)', () => {
  it('the same-site ledger seed mines executionLogs field samples into a contradiction entry', () => {
    const i = WJ_SRC.indexOf('seedLedgerFromSameSite(registry');
    const block = WJ_SRC.slice(i, i + 3200);
    assert.match(block, /executionLogs/, 'prior service execution history read');
    assert.match(block, /collectFieldSamplesFromOutput/, 'the sampler is used');
    assert.match(block, /SAME-SITE FIELD SAMPLES/, 'ledger entry names the contradiction');
    assert.match(block, /prior-service/, 'distinct provenance');
  });
  it('the USER FEEDBACK injection carries the named-field absence protocol', () => {
    const i = WJ_SRC.indexOf('USER FEEDBACK (fix request)');
    const block = WJ_SRC.slice(i, i + 1800);
    assert.match(block, /user\.observe/, 'ask the reporter what they see');
    assert.match(block, /SAME-SITE FIELD SAMPLES/, 'check the seeded contradiction evidence');
    assert.match(block, /One cold-tab aria sweep NEVER closes a named-field complaint/, 'the hard rule');
  });
});
