const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  estimateScriptTimeBudget,
  validateInputAgainstSchema,
  validateOutputAgainstSchema,
  validateSteps,
  validateForExecution,
  cleanLLMResponse
} = require('../lib/wizard-utils');

describe('estimateScriptTimeBudget', () => {
  it('sums literal setTimeout + $exists/$wait timeouts', () => {
    const s = "setTimeout(r, 2000); await $exists('.x', 3000); setTimeout(r, 1000);";
    assert.equal(estimateScriptTimeBudget(s), 6000);
  });
  it('ignores dynamic delays', () => {
    assert.equal(estimateScriptTimeBudget('setTimeout(r, dynamicMs)'), 0);
  });
  it('handles empty/null', () => {
    assert.equal(estimateScriptTimeBudget(''), 0);
    assert.equal(estimateScriptTimeBudget(null), 0);
  });
});

describe('validateInputAgainstSchema', () => {
  const schema = { type: 'object', required: ['question'], properties: { question: { type: 'string' } } };
  it('rejects missing required', () => {
    const r = validateInputAgainstSchema({}, schema);
    assert.equal(r.valid, false);
    assert.equal(r.code, 400);
    assert.match(r.error, /Missing required input: question/);
  });
  it('rejects empty required', () => {
    assert.equal(validateInputAgainstSchema({ question: '' }, schema).valid, false);
  });
  it('rejects wrong type', () => {
    const r = validateInputAgainstSchema({ question: 123 }, schema);
    assert.equal(r.valid, false);
    assert.match(r.error, /must be string, got number/);
  });
  it('rejects non-object / null input', () => {
    assert.equal(validateInputAgainstSchema('str', schema).valid, false);
    assert.equal(validateInputAgainstSchema([1], schema).valid, false);
    assert.equal(validateInputAgainstSchema(null, schema).valid, false);
  });
  it('rejects overlong string input', () => {
    const r = validateInputAgainstSchema({ question: 'x'.repeat(100001) }, schema);
    assert.equal(r.valid, false);
    assert.match(r.error, /too long/);
  });
  it('rejects oversized overall payload', () => {
    const r = validateInputAgainstSchema({ data: 'x'.repeat(500001) }, { type: 'object' });
    assert.equal(r.valid, false);
    assert.match(r.error, /too large/i);
  });
  it('accepts valid input', () => {
    assert.equal(validateInputAgainstSchema({ question: 'hi' }, schema).valid, true);
  });
});

describe('validateOutputAgainstSchema', () => {
  const out = { type: 'object', required: ['answer', 'thinking'] };
  it('flags missing/empty required', () => {
    const r = validateOutputAgainstSchema({ answer: 'ok', thinking: '' }, out);
    assert.equal(r.ok, false);
    assert.deepEqual(r.missing, ['thinking']);
    assert.equal(r.code, 'REQUIRED_OUTPUT_MISSING');
  });
  it('flags empty array required', () => {
    assert.equal(validateOutputAgainstSchema({ answer: [], thinking: 'x' }, out).ok, false);
  });
  it('passes when all required present', () => {
    assert.equal(validateOutputAgainstSchema({ answer: 'a', thinking: 't' }, out).ok, true);
  });
  it('passes when no required declared', () => {
    assert.equal(validateOutputAgainstSchema({}, { type: 'object' }).ok, true);
  });
});

describe('validateSteps warnings (time-budget)', () => {
  it('warns when a step exceeds the timeout budget', () => {
    const steps = [{ id: '1', name: 'x', onSuccess: 'TERMINATE', script: 'setTimeout(r, 40000); return 1;' }];
    const r = validateSteps(steps);
    assert.equal(r.valid, true);
    assert.ok(r.warnings && r.warnings.length);
    assert.match(r.warnings[0], /40000ms/);
  });
  it('returns no warnings field for a clean step', () => {
    const steps = [{ id: '1', name: 'x', onSuccess: 'TERMINATE', script: 'return 1;' }];
    const r = validateSteps(steps);
    assert.equal(r.valid, true);
    assert.equal(r.warnings, undefined);
  });
});

describe('validateForExecution poll-signal warning', () => {
  it('warns when a poll step (maxIterations>1) lacks any retry/done signal', () => {
    // Model A: a step opts into retry via maxIterations>1. If its script emits no
    // signal (done/ready/...), it runs once and advances without ever retrying —
    // the most common silent misconfiguration.
    const steps = [{ id: '1', name: 'x', onSuccess: 'TERMINATE', onFailure: 'TERMINATE', maxIterations: 20, script: 'await new Promise(r=>setTimeout(r,1000)); return { x: 1 };' }];
    const r = validateForExecution(steps);
    assert.equal(r.valid, true);
    assert.ok(r.warnings && r.warnings.some(w => /retry\/done signal/.test(w)));
  });

  it('does not warn when a poll step returns a done signal', () => {
    const steps = [{ id: '1', name: 'x', onSuccess: 'TERMINATE', onFailure: 'TERMINATE', maxIterations: 20, script: 'return { done: true };' }];
    const r = validateForExecution(steps);
    assert.equal(r.valid, true);
    assert.ok(!r.warnings || !r.warnings.some(w => /retry\/done signal/.test(w)));
  });

  it('does not warn for a normal step (maxIterations:1) without signals', () => {
    // A non-poll step's result is plain data — no signal expected.
    const steps = [{ id: '1', name: 'x', onSuccess: 'TERMINATE', onFailure: 'TERMINATE', maxIterations: 1, script: 'return { x: 1 };' }];
    const r = validateForExecution(steps);
    assert.equal(r.valid, true);
    assert.ok(!r.warnings || !r.warnings.some(w => /retry\/done signal/.test(w)));
  });
});

describe('cleanLLMResponse (auto-fix code extraction)', () => {
  const c = cleanLLMResponse;
  it('extracts from a closed fence', () => {
    assert.equal(c('```javascript\nawait $click("a");\n```'), 'await $click("a");');
  });
  it('extracts from an UNCLOSED fence (LLM forgot the closing ``` — the auto-fix bug)', () => {
    assert.equal(c('```js\nconst x = 1;'), 'const x = 1;');
  });
  it('returns code unchanged when there is no fence', () => {
    assert.equal(c('await $click("a");'), 'await $click("a");');
  });
  it('takes the last fenced block out of explanatory text', () => {
    assert.equal(c('Sure:\n```js\nconst x = 1;\n```\nDone.'), 'const x = 1;');
  });
  it('never leaves fence markers in the output', () => {
    const out = c('```javascript\nconst x = 1;\n```');
    assert.ok(!out.includes('```'));
  });
});
