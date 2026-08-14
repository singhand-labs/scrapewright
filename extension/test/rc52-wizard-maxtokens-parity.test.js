// RC52 audit: every wizard LLM call that embeds large page HTML must pass an
// explicit maxTokens >= 8192.
//
// FOLLOWUP to RC51. console.log 2026-08-14 12:59-13:04 showed service
// creation DYING IN ROUND 2 — before any step ran, before any hover. The
// wizard confirmSelectorsWithFullHtml call sent a 136,953-token prompt
// (full element outerHTML for every candidate selector) with NO maxTokens
// option, so llm-client fell back to its 4096 default. The model burned the
// whole 4096-token completion budget without emitting parseable content
// (finish_reason: length, empty content, output_tokens: 4096). The failure
// is deterministic — retrying with the identical 4096 cap can never succeed —
// yet llm-client retried 4 times (1351ms/2380ms/4189ms backoff) and then
// surfaced LLMRetryExhausted. Round 2 aborted; no service was generated.
//
// Root cause: asymmetric completion budgets between sibling wizard LLM calls.
// getCandidateSelectors (line 1127), the round-3/4 calls (1276, 1407), and
// the autoFix path (background.js:819, wizard.js:2229, 3322) ALL pass
// maxTokens: 8192. confirmSelectorsWithFullHtml (1159) and
// generateExplorationScript (1479) pass only { jsonMode: true } — the 4096
// default. Same asymmetry class as RC48 (dismiss timeout) and RC50 (dismiss
// tab activation): sibling paths issuing the same request with different
// budgets. The under-budgeted one fails on exactly the inputs where it
// needs the headroom — here, the largest prompts in the wizard flow.
//
// Fix: pass maxTokens: 8192 at both call sites, matching every sibling.
//
// Source-text audit pattern: wizard.js functions are not unit-testable
// directly (they drive chrome.tabs + LLMClient). Audit by slicing the
// function body from the source.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

function readSrc(rel) {
  return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
}

function sliceFunction(src, name) {
  const start = src.indexOf('async function ' + name + '(');
  assert.ok(start > -1, name + ' must be defined');
  // Slice to the next top-level async function declaration.
  const next = src.indexOf('\nasync function ', start + 1);
  return src.slice(start, next > start ? next : start + 8000);
}

function chatOptionsOf(fnBody, fnName) {
  const chatIdx = fnBody.indexOf('client.chat(');
  assert.ok(chatIdx > -1, fnName + ' must call client.chat');
  const close = fnBody.indexOf('});', chatIdx);
  assert.ok(close > chatIdx, fnName + ' client.chat call must close');
  return fnBody.slice(chatIdx, close);
}

describe('RC52: wizard LLM calls embedding large HTML pass explicit maxTokens', () => {
  it('confirmSelectorsWithFullHtml passes maxTokens >= 8192', () => {
    const body = sliceFunction(readSrc('wizard.js'), 'confirmSelectorsWithFullHtml');
    const opts = chatOptionsOf(body, 'confirmSelectorsWithFullHtml');
    const m = opts.match(/maxTokens:\s*(\d+)/);
    assert.ok(m, 'confirmSelectorsWithFullHtml must pass an explicit maxTokens ' +
      '(llm-client defaults to 4096 — insufficient for 136K-token prompts; ' +
      'console.log 2026-08-14 12:59-13:04: finish_reason:length, empty content, 4 wasted retries).');
    const val = parseInt(m[1], 10);
    assert.ok(val >= 8192,
      'confirmSelectorsWithFullHtml maxTokens must be >= 8192 (sibling-calls parity). Got: ' + val);
  });

  it('generateExplorationScript passes maxTokens >= 8192', () => {
    // Same { jsonMode: true }-only shape as the failing call; its prompt
    // embeds the full SCRIPT_DSL_GUIDE plus page info — same failure exposure.
    const body = sliceFunction(readSrc('wizard.js'), 'generateExplorationScript');
    const opts = chatOptionsOf(body, 'generateExplorationScript');
    const m = opts.match(/maxTokens:\s*(\d+)/);
    assert.ok(m, 'generateExplorationScript must pass an explicit maxTokens.');
    const val = parseInt(m[1], 10);
    assert.ok(val >= 8192,
      'generateExplorationScript maxTokens must be >= 8192 (sibling-calls parity). Got: ' + val);
  });
});

describe('RC52: no other wizard client.chat call omits maxTokens', () => {
  // Guards against a THIRD under-budgeted call site appearing in a future
  // edit. Every client.chat in wizard.js must carry an explicit maxTokens.
  it('every client.chat call in wizard.js passes an explicit maxTokens', () => {
    const src = readSrc('wizard.js');
    const calls = [];
    let idx = -1;
    while ((idx = src.indexOf('client.chat(', idx + 1)) > -1) {
      const close = src.indexOf('});', idx);
      calls.push(src.slice(idx, close));
    }
    assert.ok(calls.length >= 6, 'expected at least 6 client.chat calls in wizard.js, found ' + calls.length);
    const missing = [];
    for (const call of calls) {
      if (!/maxTokens\s*:/.test(call)) missing.push(call.slice(0, 60));
    }
    assert.deepEqual(missing, [],
      'every wizard client.chat call must pass explicit maxTokens — omitting it falls back to the ' +
      '4096 llm-client default which deterministically fails on large prompts. Missing: ' +
      JSON.stringify(missing));
  });
});

describe('RC52: comment documents the incident at the fixed call sites', () => {
  it('confirmSelectorsWithFullHtml comment references RC52 or the length-finish failure', () => {
    const src = readSrc('wizard.js');
    const start = src.indexOf('async function confirmSelectorsWithFullHtml(');
    const opts = src.indexOf('client.chat(', start);
    const before = src.slice(Math.max(0, opts - 700), opts);
    assert.ok(/RC52|finish_reason|maxTokens|token budget|length/i.test(before),
      'a comment near the confirmSelectorsWithFullHtml chat call must document WHY the explicit ' +
      'maxTokens is required (RC52 incident: 136K-token prompt, 4096 default cap, deterministic ' +
      'empty-content length-finish, 4 wasted retries).');
  });
});
