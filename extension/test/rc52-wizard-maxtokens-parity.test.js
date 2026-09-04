// extension/test/rc52-wizard-maxtokens-parity.test.js
//
// RC52/RC53 invariant, post-research-session: the wizard's ONLY LLM call
// path is the session adapter, and it forwards the engine's maxTokens
// (which the wiring sets from the user's maxOutputTokens knob, never a
// hardcoded sub-8192 literal). wizard.js cannot load in Node — source audit.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'wizard.js'), 'utf8');

function fnBody(name) {
  const start = SRC.indexOf('function ' + name + '(');
  assert.ok(start !== -1, 'function ' + name + ' exists');
  let i = SRC.indexOf('{', start), depth = 0;
  for (; i < SRC.length; i++) {
    if (SRC[i] === '{') depth += 1;
    else if (SRC[i] === '}') { depth -= 1; if (depth === 0) return SRC.slice(start, i + 1); }
  }
  throw new Error('unbalanced');
}

describe('RC52/RC53: wizard LLM budget parity', () => {
  it('the session adapter forwards maxTokens on every chat call', () => {
    const body = fnBody('makeLlmAdapter');
    // Nineteenth log: the options bag also carries onRetry (retry visibility)
    // — the maxTokens forwarding requirement is unchanged.
    assert.match(body, /client\.chat\(messages,\s*\{\s*maxTokens,/s, 'adapter passes maxTokens');
    assert.ok(!/maxTokens:\s*\d+/.test(body), 'adapter never hardcodes a budget');
  });
  it('the session budget takes the user maxOutputTokens knob, never a hardcoded cap', () => {
    assert.match(SRC, /maxTokensPerCall:\s*\(config\.config\.maxOutputTokens[^)]*\)\s*\|\|\s*16384/);
    assert.ok(!/maxTokens:\s*(4096|8192)\b/.test(fnBody('makeLlmAdapter')), 'no hardcoded budget in the adapter');
  });
  it('no other direct client.chat call sites in wizard.js bypass the adapter (generation helpers excepted — they inherit the config knob via llm-client)', () => {
    // generateStepScript and improveStepWithAI call client.chat(messages, {})
    // — empty options let llm-client resolve the config knob (RC53). The
    // invariant is: NO literal maxTokens anywhere in wizard.js.
    assert.ok(!/maxTokens:\s*\d+/.test(SRC), 'no literal maxTokens in wizard.js');
  });
});
