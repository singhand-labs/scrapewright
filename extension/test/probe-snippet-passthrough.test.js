// Code-review P3 regression: probe.snippet envelope — r.error is a failure
// only when it is the SOLE own key; a shaped return carrying an error field
// passes through as data with a note. The observation log records the code
// head + hash.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createProbeTools } = require('../lib/probe-tools');

describe('#9 probe.snippet envelope', () => {
  it('{result:{error:"x", data:1}} passes through with a note', async () => {
    const tools = createProbeTools({ executeDsl: async () => ({ error: 'x', data: 1 }) });
    const r = await tools.snippet({ code: 'return {error:"x", data:1};' });
    assert.ok(!r.error, 'no tool-level error');
    assert.ok(r.result.includes('"data"'));
    assert.match(r.note, /passed through/);
  });
  it('a sole-key {error} still maps to the tool error', async () => {
    const tools = createProbeTools({ executeDsl: async () => ({ error: 'ELEMENT_NOT_FOUND: .x' }) });
    const r = await tools.snippet({ code: 'return $.x;' });
    assert.match(r.error, /ELEMENT_NOT_FOUND/);
  });
  it('observation log summary carries the code head + hash', async () => {
    const recorded = [];
    const tools = createProbeTools({
      executeDsl: async () => 42,
      observationLog: { record: (e) => recorded.push(e) }
    });
    await tools.snippet({ code: 'return $count(".post");' });
    assert.equal(recorded.length, 1);
    assert.match(recorded[0].summary, /hash=-?\d+/);
    assert.match(recorded[0].summary, /head=/);
    assert.match(recorded[0].summary, /return \\\$count|return \$count/);
  });
});
