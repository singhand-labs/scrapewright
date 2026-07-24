// Regression for bugx.log 2026-07-24 LLM JSON malformations.
//
// 02:47:40 incident: generateStepsWithSelectors failed because LLM emitted
// 8218 chars of JSON that JSON.parse rejected at position 7108 ("Expected
// property name or '}'"). First fix added parseJsonLenient handling trailing
// commas and JS-style comments.
//
// 07:49:10 incident (this test file's update): the same parser failed at
// position 7050 with "Expected property name or '}'" but repairsAttempted
// was empty — the existing trailing-comma / comment-strip repairs didn't
// help because the LLM had emitted a bare (unquoted) key OR omitted a comma
// between properties. "Expected property name or '}'" specifically means
// the parser is inside an object after `{` or `,` and didn't see a string
// key or `}`. This file now covers the new char-walking repair pass that
// handles bare keys, single-quoted strings, missing commas, leading commas,
// and double commas.

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

  describe('bare (unquoted) keys', () => {
    it('quotes a single bare key', () => {
      const res = parseJsonLenient('{ id: "1" }');
      assert.equal(res.ok, true);
      assert.deepEqual(res.value, { id: '1' });
      assert.ok(res.repairs.includes('repair-common-mistakes'));
    });

    it('quotes multiple bare keys', () => {
      // bugx.log 07:49:10 shape — LLM emitted a step object with JS-style keys.
      const res = parseJsonLenient('{\n  id: "1",\n  name: "wait_for_posts",\n  script: "return 1;"\n}');
      assert.equal(res.ok, true);
      assert.equal(res.value.id, '1');
      assert.equal(res.value.name, 'wait_for_posts');
      assert.equal(res.value.script, 'return 1;');
    });

    it('quotes bare keys inside nested objects in an array', () => {
      const input = '{ steps: [{ id: "1", onSuccess: "2" }, { id: "2" }] }';
      const res = parseJsonLenient(input);
      assert.equal(res.ok, true);
      assert.equal(res.value.steps.length, 2);
      assert.equal(res.value.steps[0].id, '1');
      assert.equal(res.value.steps[0].onSuccess, '2');
    });

    it('does not treat true/false/null values as bare keys', () => {
      const res = parseJsonLenient('{ "ready": true, "done": false, "value": null }');
      assert.equal(res.ok, true);
      assert.equal(res.value.ready, true);
      assert.equal(res.value.done, false);
      assert.equal(res.value.value, null);
      assert.deepEqual(res.repairs, []);
    });
  });

  describe('single-quoted strings', () => {
    it('converts single-quoted keys and values to double-quoted', () => {
      const res = parseJsonLenient("{ 'id': '1', 'name': 'wait' }");
      assert.equal(res.ok, true);
      assert.deepEqual(res.value, { id: '1', name: 'wait' });
    });

    it('preserves literal double-quotes inside single-quoted values (escaped)', () => {
      // LLM emits script with a double-quote inside single quotes — repair must
      // escape it so the resulting JSON string stays valid.
      const res = parseJsonLenient("{ 'script': '$extract(\"h1\")' }");
      assert.equal(res.ok, true);
      assert.equal(res.value.script, '$extract("h1")');
    });

    it('handles escaped single-quote inside single-quoted value', () => {
      const res = parseJsonLenient("{ 'text': 'don\\'t go' }");
      assert.equal(res.ok, true);
      assert.equal(res.value.text, "don't go");
    });
  });

  describe('missing commas between properties / elements', () => {
    it('inserts missing comma between object members', () => {
      // Direct trigger for "Expected property name or '}'" — LLM forgot the
      // comma between two properties.
      const res = parseJsonLenient('{ "id": "1" "name": "wait" }');
      assert.equal(res.ok, true);
      assert.deepEqual(res.value, { id: '1', name: 'wait' });
    });

    it('inserts missing comma between array elements (strings)', () => {
      const res = parseJsonLenient('[ "a" "b" "c" ]');
      assert.equal(res.ok, true);
      assert.deepEqual(res.value, ['a', 'b', 'c']);
    });

    it('inserts missing comma between array elements (numbers)', () => {
      const res = parseJsonLenient('[1 2 3]');
      assert.equal(res.ok, true);
      assert.deepEqual(res.value, [1, 2, 3]);
    });

    it('inserts missing comma between closing brace and next key', () => {
      // Nested object followed by another property — common when LLM emits
      // compact JSON.
      const input = '{ "config": { "port": 80 } "name": "x" }';
      const res = parseJsonLenient(input);
      assert.equal(res.ok, true);
      assert.equal(res.value.config.port, 80);
      assert.equal(res.value.name, 'x');
    });
  });

  describe('leading and double commas', () => {
    it('drops a leading comma in an object', () => {
      const res = parseJsonLenient('{, "id": "1" }');
      assert.equal(res.ok, true);
      assert.deepEqual(res.value, { id: '1' });
    });

    it('drops a leading comma in an array', () => {
      const res = parseJsonLenient('[, 1, 2]');
      assert.equal(res.ok, true);
      assert.deepEqual(res.value, [1, 2]);
    });

    it('collapses double commas into one', () => {
      const res = parseJsonLenient('["a",, "b"]');
      assert.equal(res.ok, true);
      assert.deepEqual(res.value, ['a', 'b']);
    });

    it('collapses triple commas into one', () => {
      const res = parseJsonLenient('["a",,, "b"]');
      assert.equal(res.ok, true);
      assert.deepEqual(res.value, ['a', 'b']);
    });
  });

  describe('combined and string-safety cases', () => {
    it('repairs combined bare keys + missing commas + trailing comma', () => {
      // bugx.log-style realistic shape: JS object-literal with multiple mistakes.
      const input = '{\n  id: "1"\n  name: "wait"\n  script: "return 1;",\n}';
      const res = parseJsonLenient(input);
      assert.equal(res.ok, true);
      assert.equal(res.value.id, '1');
      assert.equal(res.value.name, 'wait');
      assert.equal(res.value.script, 'return 1;');
    });

    it('does NOT touch bare-key-looking text inside a JSON string value', () => {
      // Script string contains `{ id: 1 }` as literal text — must NOT be
      // rewritten to `{ "id": 1 }` (that would corrupt the script semantics).
      const input = '{"script": "const x = { id: 1 }; return x;"}';
      const res = parseJsonLenient(input);
      assert.equal(res.ok, true);
      assert.equal(res.value.script, 'const x = { id: 1 }; return x;');
      assert.deepEqual(res.repairs, []);
    });

    it('does NOT insert a comma between two adjacent strings inside a JSON string', () => {
      // The inner `[\"a\" \"b\"]` is text inside the outer script string, not
      // an array literal to repair.
      const input = '{"script": "let arr = [\\"a\\" \\"b\\"];"}';
      const res = parseJsonLenient(input);
      assert.equal(res.ok, true);
      assert.equal(res.value.script, 'let arr = ["a" "b"];');
      assert.deepEqual(res.repairs, []);
    });
  });

  describe('failure modes', () => {
    it('returns ok:false with error message for truly malformed input', () => {
      const res = parseJsonLenient('{not even close');
      assert.equal(res.ok, false);
      assert.ok(typeof res.error === 'string' && res.error.length > 0);
    });

    it('returns ok:false for empty input', () => {
      const res = parseJsonLenient('');
      assert.equal(res.ok, false);
    });

    it('returns ok:false for truncated input (no closing brace)', () => {
      // Real truncation — can't be repaired by string-level heuristics.
      const res = parseJsonLenient('{"id":"1","script":"return');
      assert.equal(res.ok, false);
      assert.ok(res.repairs !== undefined);
    });

    it('exposes repaired output preview on failure for diagnostics', () => {
      // Truly unrepairable shape: two adjacent identifiers with no colon.
      // parseJsonLenient will still fail, but the failure exposes what was tried.
      const res = parseJsonLenient('{ a b }');
      assert.equal(res.ok, false);
      assert.ok(res.repairs !== undefined, 'repairs array is present for diagnosis');
    });
  });
});
