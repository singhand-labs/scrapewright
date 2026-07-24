// Regression for bugx.log 2026-07-24 02:47:40 — generateStepsWithSelectors
// failed because LLM emitted 8218 chars of JSON that JSON.parse rejected at
// position 7108 ("Expected property name or '}'"). The wizard's 5 parse sites
// had no fallback. parseJsonLenient handles the most common LLM malformations
// (trailing commas, JS-style comments) and returns diagnostic info so future
// failures pinpoint the exact bad character.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { parseJsonLenient } = require('../lib/wizard-utils');

describe('parseJsonLenient', () => {
  it('passes through strict valid JSON with no repairs', () => {
    const res = parseJsonLenient('{"a":1,"b":[2,3]}');
    assert.equal(res.ok, true);
    assert.deepEqual(res.value, { a: 1, b: [2, 3] });
    assert.deepEqual(res.repairs, []);
  });

  it('repairs trailing comma in object', () => {
    const res = parseJsonLenient('{"a":1,"b":2,}');
    assert.equal(res.ok, true);
    assert.deepEqual(res.value, { a: 1, b: 2 });
    assert.ok(res.repairs.includes('remove-trailing-commas'));
  });

  it('repairs trailing comma in array', () => {
    const res = parseJsonLenient('[1,2,3,]');
    assert.equal(res.ok, true);
    assert.deepEqual(res.value, [1, 2, 3]);
    assert.ok(res.repairs.includes('remove-trailing-commas'));
  });

  it('repairs trailing comma with whitespace before brace', () => {
    const res = parseJsonLenient('{\n  "id": "1",\n  "name": "wait",\n}');
    assert.equal(res.ok, true);
    assert.equal(res.value.id, '1');
  });

  it('strips JS line comments outside strings', () => {
    const res = parseJsonLenient('{\n  // this is the first step\n  "id": "1"\n}');
    assert.equal(res.ok, true);
    assert.equal(res.value.id, '1');
    assert.ok(res.repairs.includes('strip-comments'));
  });

  it('strips JS block comments outside strings', () => {
    const res = parseJsonLenient('{\n  /* multi\n     line */\n  "id": "1"\n}');
    assert.equal(res.ok, true);
    assert.equal(res.value.id, '1');
  });

  it('does NOT strip // that appears inside a JSON string value', () => {
    // Realistic: script code embedded in JSON contains "// comment" as part of
    // its text — stripping that would corrupt the script.
    const input = '{"script": "// real comment\\nreturn 1;"}';
    const res = parseJsonLenient(input);
    assert.equal(res.ok, true);
    assert.equal(res.value.script, '// real comment\nreturn 1;');
    assert.deepEqual(res.repairs, []);
  });

  it('handles combined comments + trailing commas', () => {
    const input = '{\n  // step 1\n  "steps": [\n    { "id": "1" },\n    { "id": "2" },\n  ],\n}';
    const res = parseJsonLenient(input);
    assert.equal(res.ok, true);
    assert.deepEqual(res.value.steps.map(s => s.id), ['1', '2']);
  });

  it('repairs realistic LLM output: embedded JS return + trailing comma', () => {
    // Mirrors bugx.log failure shape — LLM emits JS object-literal returns
    // inside script strings, plus a trailing comma at the end of the steps array.
    const input = JSON.stringify({
      steps: [
        { id: '1', name: 'wait', script: 'return { done: true };', onSuccess: '2' },
        { id: '2', name: 'extract', script: 'return { posts: [] };', onSuccess: 'TERMINATE' }
      ]
    }).replace(/("TERMINATE"\s*)\]/, '$1,]');  // inject trailing comma
    const res = parseJsonLenient(input);
    assert.equal(res.ok, true);
    assert.equal(res.value.steps.length, 2);
    assert.equal(res.value.steps[0].script, 'return { done: true };');
  });

  it('returns ok:false with error message for truly malformed input', () => {
    const res = parseJsonLenient('{not even close');
    assert.equal(res.ok, false);
    assert.ok(typeof res.error === 'string' && res.error.length > 0);
  });

  it('returns ok:false for empty input', () => {
    const res = parseJsonLenient('');
    assert.equal(res.ok, false);
  });

  it('exposes repaired output preview on failure for diagnostics', () => {
    const res = parseJsonLenient('{\n  broken: true\n}');
    // Unquoted keys are NOT repaired by parseJsonLenient (risky heuristic), so
    // this should still fail — but the failure should expose what was tried.
    assert.equal(res.ok, false);
    assert.ok(res.repairs !== undefined, 'repairs array is present for diagnosis');
  });
});
