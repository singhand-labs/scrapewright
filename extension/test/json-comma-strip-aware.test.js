// Code-review P2 regressions: string-aware trailing-comma strip + round
// count in the escape-inner-quotes repairs token (wizard-utils parseJsonLenient).
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { parseJsonLenient } = require('../lib/wizard-utils.js');

describe('#7 string-aware comma strip', () => {
  it('payload string containing ", ]" survives untouched (comma is content)', () => {
    const out = parseJsonLenient('{"a": "keep , ] me", "b": 1,}');
    assert.ok(out.ok, 'parses after repairs');
    assert.equal(out.value.a, 'keep , ] me');
    assert.equal(out.value.b, 1);
    assert.ok(out.repairs.includes('remove-trailing-commas'));
  });
  it('payload string containing ", }" survives untouched', () => {
    const out = parseJsonLenient('{"a": "brace , } here",}');
    assert.ok(out.ok);
    assert.equal(out.value.a, 'brace , } here');
  });
  it('escape-inner-quotes token carries the round count (ambiguity disclosure)', () => {
    const out = parseJsonLenient('{"note": "he said "wow", "then left", "b": 1}');
    assert.ok(out.ok, JSON.stringify(out));
    const tok = out.repairs.find((r) => /^escape-inner-quotes(:\d+)?$/.test(r));
    assert.ok(tok, 'token present: ' + JSON.stringify(out.repairs));
    assert.match(tok, /^escape-inner-quotes:\d+$/, 'round count included');
  });
});
