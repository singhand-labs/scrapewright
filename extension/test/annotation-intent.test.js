const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { ANNOTATION_PURPOSES, WAIT_CONDITIONS, buildAnnotationsText } = require('../lib/wizard-utils');

describe('annotation intent presets', () => {
  it('exposes purpose presets including an other/freeform path', () => {
    const vals = ANNOTATION_PURPOSES.map(p => p.value);
    assert.ok(vals.includes('submit'));
    assert.ok(vals.includes('toggle'));
    assert.ok(vals.includes('wait-for-load'));
    assert.ok(vals.includes('other'));
  });
  it('exposes waitCondition presets', () => {
    const vals = WAIT_CONDITIONS.map(w => w.value);
    assert.deepEqual(vals.sort(), ['appear','attributeChange','disappear','textStable']);
  });
});

describe('buildAnnotationsText', () => {
  it('emits intent fields when present', () => {
    const out = buildAnnotationsText([
      { type: 'check', selector: '.loading', purpose: 'wait-for-load', waitCondition: 'disappear' },
      { type: 'extract', selector: '.answer', outputField: 'answer' },
      { type: 'input', selector: '#q', inputField: 'question' },
      { type: 'click', selector: '.btn', text: '提交', purpose: 'submit' }
    ]);
    assert.match(out, /type: check.*purpose: wait-for-load.*waitCondition: disappear/);
    assert.match(out, /type: extract.*outputField: answer/);
    assert.match(out, /type: input.*inputField: question/);
    assert.match(out, /type: click.*text: "提交".*purpose: submit/);
  });
  it('omits intent fields when absent (backward compat)', () => {
    const out = buildAnnotationsText([{ type: 'click', selector: '.btn', text: 'x' }]);
    assert.ok(!out.includes('purpose'));
    assert.ok(!out.includes('outputField'));
    assert.match(out, /type: click.*text: "x".*selector: \.btn/);
  });
});
