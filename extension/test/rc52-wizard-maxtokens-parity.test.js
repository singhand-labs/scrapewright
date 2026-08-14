// RC52 audit, superseded in part by RC53.
//
// RC52 (console.log 2026-08-14 12:59-13:04): service creation DIED IN ROUND 2.
// confirmSelectorsWithFullHtml sent a 136,953-token prompt with NO maxTokens,
// so llm-client fell back to its 4096 default. The model burned the whole
// completion budget without emitting parseable content (finish_reason:length,
// empty content), the deterministic failure retried 4x, then
// LLMRetryExhausted aborted the round. Original fix: explicit maxTokens: 8192
// at both under-budgeted call sites + a guard that every wizard client.chat
// carries explicit maxTokens.
//
// RC53 evolution: the user chose to make the completion budget a per-provider
// CONFIG PARAMETER (Settings → maxOutputTokens) threaded through the whole
// flow. llm-client now resolves options.maxTokens ?? config.maxOutputTokens
// ?? 8192 at the single budgeting site, and every call-site hardcode was
// REMOVED (a hardcoded 8192 would cap a user configuring 16384). The guard
// here is updated to the new invariant:
//   1. wizard/background call sites do NOT hardcode maxTokens:8192 (config
//      is authoritative — behavioral chain tested in
//      rc53-maxoutputtokens-config.test.js).
//   2. No call site hardcodes a value BELOW 8192 — that reintroduces the RC52
//      failure mode even when no config is set.
//   3. The incident stays documented at the fixed call site.

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

describe('RC52/RC53: completion budget is config-driven, never sub-8192', () => {
  it('confirmSelectorsWithFullHtml does not hardcode a completion budget', () => {
    const body = sliceFunction(readSrc('wizard.js'), 'confirmSelectorsWithFullHtml');
    assert.ok(!/maxTokens\s*:\s*\d+/.test(body),
      'the completion budget comes from the maxOutputTokens config (RC53); a call-site ' +
      'hardcode caps users who configure a larger budget');
  });

  it('generateExplorationScript does not hardcode a completion budget', () => {
    const body = sliceFunction(readSrc('wizard.js'), 'generateExplorationScript');
    assert.ok(!/maxTokens\s*:\s*\d+/.test(body),
      'the completion budget comes from the maxOutputTokens config (RC53)');
  });
});

describe('RC52/RC53: no call site hardcodes sub-8192 budgets', () => {
  // Guards against a future edit reintroducing the RC52 failure mode: an
  // explicit maxTokens below 8192 truncates large-prompt calls even when no
  // config is set (deterministic finish_reason:length + empty content).
  it('wizard.js contains no numeric maxTokens below 8192', () => {
    const src = readSrc('wizard.js');
    const sub8192 = [];
    const re = /maxTokens\s*:\s*(\d+)/g;
    let m;
    while ((m = re.exec(src)) !== null) {
      if (parseInt(m[1], 10) < 8192) sub8192.push(m[0]);
    }
    assert.deepEqual(sub8192, [],
      'wizard.js must not hardcode maxTokens < 8192 (RC52 failure mode). Found: ' +
      JSON.stringify(sub8192));
  });
});

describe('RC52: comment documents the incident at the fixed call site', () => {
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
