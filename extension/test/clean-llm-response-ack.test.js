const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { cleanLLMResponse } = require('../lib/wizard-utils');

describe('cleanLLMResponse — ACK/NACK protocol', () => {
  beforeEach(() => {
    // debugLogger is referenced in source; provide a no-op for tests
    const dom = new JSDOM('<!DOCTYPE html>');
    global.window = dom.window;
    global.debugLogger = { log() {} };
  });

  it('strips leading // ACK: line and returns remainder', () => {
    const input = '// ACK: find posts by role=article\nreturn { posts: await $extractList(...) };';
    const out = cleanLLMResponse(input);
    assert.equal(out, 'return { posts: await $extractList(...) };');
  });

  it('strips leading // NACK: line and returns remainder', () => {
    const input = '// NACK: cannot because selector is ambiguous\nreturn { posts: [] };';
    const out = cleanLLMResponse(input);
    assert.equal(out, 'return { posts: [] };');
  });

  it('preserves script when no ACK/NACK prefix', () => {
    const input = 'return { foo: 1 };';
    assert.equal(cleanLLMResponse(input), 'return { foo: 1 };');
  });

  it('handles ACK with no newline (returns empty remainder)', () => {
    const input = '// ACK: paraphrase only';
    const out = cleanLLMResponse(input);
    assert.equal(out, '');
  });

  it('does NOT strip ACK-style comment that is not at position 0', () => {
    // Mid-script comment is legitimate code, not a protocol marker
    const input = 'return {\n  // ACK: not a protocol marker\n  x: 1\n};';
    const out = cleanLLMResponse(input);
    assert.equal(out, input);
  });

  it('only examines the very first line', () => {
    const input = '// ACK: line one\n// second comment line\nreturn 1;';
    const out = cleanLLMResponse(input);
    assert.equal(out, '// second comment line\nreturn 1;');
  });
});
