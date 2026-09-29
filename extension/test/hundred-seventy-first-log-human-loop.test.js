// extension/test/hundred-seventy-first-log-human-loop.test.js
//
// 171st round — human-loop enhancement + selector generalization, from
// the user's directive: "当某个字段或操作（选择器）LLM理解错误2次时，
// 便请求协助标注。请求协助标注要精准要求目标字段" + "选择器推理要多
// 选取一些不同情形的后选项来拟合选择器，不能看一两个样本就决定"。
// Choice C: sampling diversity + generalization verification closed loop.
//
//   A. Field-fail ledger — research-session tracks per-FIELD failure
//      counts across verifies/probes; at 2 failures the engine injects
//      FIELD_ASSIST_REQUEST naming the field, the error history, and a
//      concrete annotation instruction.
//   B. Sample diversity — probe.sample/probe.skeleton gain samples:N
//      (first/middle/last); a diversity digest summarizes key differences;
//      a TIP line nudges when >=3 containers match and samples was omitted.
//   C. Generalization check — service.update static lint samples each new
//      container selector at 3 positions; partial match yields
//      SELECTOR_PARTIAL_FIT advisory naming the divergent sample.
const { test, describe, it } = require('node:test');
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const WU = require('../lib/wizard-utils');
const RS = fs.readFileSync(path.join(__dirname, '..', 'lib', 'research-session.js'), 'utf8');
const ST = fs.readFileSync(path.join(__dirname, '..', 'lib', 'session-tools.js'), 'utf8');

describe('171 A — field-fail ledger → FIELD_ASSIST_REQUEST', () => {
  it('the ledger and injection exist in research-session source', () => {
    assert.match(RS, /fieldFailLedger/, 'the ledger is declared');
    assert.match(RS, /FIELD_ASSIST_REQUEST/, 'the system note name exists');
    const i = RS.indexOf('FIELD_ASSIST_REQUEST');
    const block = RS.slice(i - 400, i + 800);
    assert.match(block, /annotate\.request/, 'the note routes to annotate.request');
    assert.match(block, /fields:\s*\[/, 'the note specifies the field list');
    assert.match(block, /MARK\b/i, 'the note tells the user what to mark');
    assert.match(block, /count\s*>=\s*2|\.count === 2/, 'fires at 2 failures');
  });
  it('field names are extracted from verify detector errors', () => {
    const WUmod = require('../lib/wizard-utils');
    assert.ok(typeof WUmod.extractFailingFieldNames === 'function', 'the extractor exists');
    const detectors = {
      partialEmptyFields: [{ path: 'posts.postId', field: 'postId', emptyCount: 3, totalCount: 4 }],
      capturedValueUnbound: [{ field: 'postTime', path: 'posts.postTime', semantic: 'absoluteTime' }]
    };
    const fields = WUmod.extractFailingFieldNames(detectors);
    assert.ok(fields.includes('postId'), 'postId from partialEmptyFields');
    assert.ok(fields.includes('postTime'), 'postTime from capturedValueUnbound');
  });
});

describe('171 B — sample diversity (samples:N + digest + TIP)', () => {
  it('probe.sample tool spec carries the samples parameter', () => {
    assert.match(ST, /samples[,:]/, 'the parameter is declared');
    assert.match(ST, /first\/middle\/last/, 'sample positions labeled');
  });
  it('computeSampleDiversity returns a digest of key differences', () => {
    assert.ok(typeof WU.computeSampleDiversity === 'function', 'the digest helper exists');
    const digest = WU.computeSampleDiversity([
      { text: 'Post A about AI with a very long text body that has many words', attrs: { role: 'article', 'data-id': '1' } },
      { text: '', attrs: { role: 'article' } },
      { text: 'Post C', attrs: { role: 'article', 'aria-label': 'photo' } }
    ]);
    assert.ok(digest && digest.length > 0, 'differences are summarized');
    assert.match(digest, /text|attr/i, 'the digest names what differs');
  });
});

describe('171 C — SELECTOR_PARTIAL_FIT generalization check', () => {
  it('the advisory exists in session-tools static lint', () => {
    assert.match(ST, /SELECTOR_PARTIAL_FIT/, 'the advisory name exists');
    const i = ST.indexOf('SELECTOR_PARTIAL_FIT');
    const block = ST.slice(i - 500, i + 600);
    assert.match(block, /samples|first.*middle.*last/i, 'samples at multiple positions');
    assert.match(block, /over-?fitted/i, 'the warning names over-fitting');
  });
});
