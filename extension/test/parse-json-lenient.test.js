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

  // bugx.log 2026-07-24 (later incident): generateStepsWithSelectors emitted
  // JSON that failed at position 6671 with "Expected property name or '}'".
  // Root cause: LLM routinely writes JS selectors like
  //   $count('div[role="article"]')
  // inside the `script` field, leaving the inner `"` unescaped. JSON.parse
  // terminates the value at the first such `"`; the walker then misparses
  // the remainder (the LLM's intended identifier ends up where a property
  // name should go). The fix: for values of code-bearing keys (script,
  // functionBody, expression, code, condition), use a depth-aware reader
  // that escapes any `"` inside JS-bracket contexts ([{()]) and only treats
  // `"` as the JSON terminator when depth is 0 AND the next non-whitespace
  // char is a JSON structural separator (, } ] or EOF).
  describe('code-bearing key handling (unescaped " in script values)', () => {
    it('escapes unescaped " inside script value (CSS attribute selector)', () => {
      // The bugx.log scenario: $count('div[role="article"]') emitted verbatim.
      const input = `{"id":"1","script":"const c = await $count('div[role="article"]'); return { done: c > 0 };"}`;
      const res = parseJsonLenient(input);
      assert.equal(res.ok, true);
      assert.equal(res.value.id, '1');
      // The parsed script must contain the JS selector with the inner quotes intact.
      assert.equal(res.value.script, "const c = await $count('div[role=\"article\"]'); return { done: c > 0 };");
      assert.ok(res.repairs.includes('repair-common-mistakes'));
    });

    it('does not double-escape already-escaped " inside script value', () => {
      // LLM properly escaped the inner quotes — the repair pass must preserve
      // them as-is, not turn \" into \\" (which would change the parsed value).
      const input = `{"id":"1","script":"x = \\"hi\\"; return { done: true };"}`;
      const res = parseJsonLenient(input);
      assert.equal(res.ok, true);
      assert.equal(res.value.script, 'x = "hi"; return { done: true };');
    });

    it('preserves already-escaped backslash + quote (\\") verbatim', () => {
      // Input has `\"` (one backslash + one quote, valid JSON escape for `"`).
      // Output must have the same `\"` — not `\\"` (which would decode to `\` + `"`).
      const input = `{"script":"x = 'he said \\"hi\\"'"}`;
      const res = parseJsonLenient(input);
      assert.equal(res.ok, true);
      assert.equal(res.value.script, 'x = \'he said "hi"\'');
    });

    it('handles bare-key script field with unescaped inner "', () => {
      // LLM occasionally emits bare keys (no quotes around `script`).
      const input = `{id:"1",script:"x = get('a"b'); return { done: true };"}`;
      const res = parseJsonLenient(input);
      assert.equal(res.ok, true);
      assert.equal(res.value.script, "x = get('a\"b'); return { done: true };");
    });

    it('handles multiple unescaped " scattered through the script', () => {
      const input = `{"id":"1","script":"a = getX('role="admin"'); b = getY('aria="true"'); return { done: a || b };"}`;
      const res = parseJsonLenient(input);
      assert.equal(res.ok, true);
      assert.equal(res.value.script,
        "a = getX('role=\"admin\"'); b = getY('aria=\"true\"'); return { done: a || b };");
    });

    it('does not terminate early when " is followed by ] inside a CSS selector', () => {
      // Without the depth counter, the second `"` (followed by `]`) would
      // look like a real JSON terminator (string `]` is a JSON structural).
      // The depth counter knows we're still inside the `[` from `[role=`.
      const input = `{"id":"1","script":"const x = arr.filter(item => item.id === 'a"b')[0]; return { done: !!x };"}`;
      const res = parseJsonLenient(input);
      assert.equal(res.ok, true);
      assert.equal(res.value.script,
        "const x = arr.filter(item => item.id === 'a\"b')[0]; return { done: !!x };");
    });

    it('handles nested objects with code-bearing values at multiple levels', () => {
      const input = `{"steps":[{"id":"1","script":"x = 'he said \\"hi\\"'"},{"id":"2","script":"y = $count('div[role="article"]')"}]}`;
      const res = parseJsonLenient(input);
      assert.equal(res.ok, true);
      assert.equal(res.value.steps[0].script, 'x = \'he said "hi"\'');
      assert.equal(res.value.steps[1].script, "y = $count('div[role=\"article\"]')");
    });

    it('resets code-bearing context across sibling fields', () => {
      // After parsing `script`, the next field's value should NOT be treated
      // as code-bearing. The `name` field's value is normal text — if it
      // contains an unescaped " we should NOT escape it (we don't fix
      // non-code-bearing fields; that's too risky).
      const input = `{"script":"x = 'a'","name":"hello"}`;
      const res = parseJsonLenient(input);
      assert.equal(res.ok, true);
      assert.equal(res.value.script, "x = 'a'");
      assert.equal(res.value.name, 'hello');
    });

    it('treats condition (a code-bearing key) the same as script', () => {
      // `condition` is in CODE_BEARING_KEYS because step conditions are JS exprs.
      const input = `{"id":"1","condition":"document.querySelector('div[role="article"]') !== null","script":"return { done: true };"}`;
      const res = parseJsonLenient(input);
      assert.equal(res.ok, true);
      assert.equal(res.value.condition,
        "document.querySelector('div[role=\"article\"]') !== null");
    });

    it('does NOT apply code-bearing repair to non-code-bearing keys (too risky)', () => {
      // `name` is free text — we deliberately do not escape unescaped " here.
      // If we did, we'd paper over genuine truncation in non-code fields.
      const input = `{"name":"a"b","script":"x"}`;
      const res = parseJsonLenient(input);
      assert.equal(res.ok, false);
      assert.match(res.error, /property name|property value/i);
    });

    it('code-bearing mode handles trailing semicolon before closing "', () => {
      // Common LLM pattern: end the JS statement with ;, then close the JSON string.
      const input = `{"script":"return { ok: true };"}`;
      const res = parseJsonLenient(input);
      assert.equal(res.ok, true);
      assert.equal(res.value.script, 'return { ok: true };');
    });

    it('bare-word CSS attribute (the recommended workaround) parses cleanly', () => {
      // The prompt now recommends `[role=article]` over `[role="article"]`
      // to sidestep the escape issue entirely.
      const input = `{"id":"1","script":"const c = await $count('div[role=article]'); return { done: c > 0 };"}`;
      const res = parseJsonLenient(input);
      assert.equal(res.ok, true);
      assert.equal(res.value.script, "const c = await $count('div[role=article]'); return { done: c > 0 };");
      // No repair was needed — the input is already valid JSON.
      assert.deepEqual(res.repairs, []);
    });
  });
});
