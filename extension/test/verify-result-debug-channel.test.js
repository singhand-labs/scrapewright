// Twenty-fourth log: the model shipped a step whose return carried a small
// debug payload ({posts: [...], debugTime: {containerCount, firstFew}}) and
// then said "finalResult被截断看不到debugTime" — the verify.run report
// serializes finalResult (3 sampled records × 2000-char strings) AFTER the
// detectors, and the engine renders tool results to the model through a
// 4000-char capped summary, so the debug key never entered the window. The
// model burnt a whole turn on a debug-only step to learn one fact
// (span[aria-labelledby] matches 0 on cold tabs) that its own debug payload
// already contained.
//
// Fix: report.resultDebug — small NON-record keys of finalResult lifted
// AHEAD of the sampled record array in the report key order, each capped.
// The record list stays in finalResult (human/diag channel); the model's
// debug channel survives the summary window.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createVerifyRunner } = require('../lib/verify-runner');

function makeRunner(orchestrate) {
  const deps = {
    orchestrate,
    ensureLock: async () => {},
    getSignal: () => null,
    log: () => {},
    onEvent: () => {},
    createTab: async (url) => ({ id: 11, url }),
    removeTab: async () => {},
    waitForTabLoad: async () => {},
    sendMessage: async () => ({ pong: true }),
    executeScript: async () => ({ result: 'ok', selectorDiagnostics: [] }),
    captureSnapshot: async () => ({ html: '<html></html>' }),
    evaluateCondition: async () => true
  };
  return createVerifyRunner(deps);
}

const SERVICE = { targetUrl: 'https://example.com', steps: [{ id: 's1', name: 'one', script: 'return 1', onSuccess: 'TERMINATE' }], config: {} };
const SCHEMA = { type: 'object', required: ['posts'], properties: { posts: { type: 'array' } } };

describe('verify report resultDebug channel (twenty-fourth log)', () => {
  it('lifts small non-record keys of finalResult into report.resultDebug', async () => {
    const orch = async () => ({
      finalResult: {
        posts: [{ a: 1 }, { a: 2 }],
        debugTime: { containerCount: 14, firstFew: [{ lbs: [] }, { lbs: [] }] }
      },
      steps: [], pages: []
    });
    const out = await makeRunner(orch)({ service: SERVICE, input: {}, outputSchema: SCHEMA });
    assert.ok(out.report.resultDebug, 'resultDebug present');
    assert.ok(out.report.resultDebug.debugTime, 'the model\'s debug key survived');
    assert.ok(out.report.resultDebug.debugTime.indexOf('containerCount') !== -1, 'value serialized');
    assert.equal(out.report.resultDebug.posts, undefined, 'record-array keys stay in finalResult, not duplicated here');
  });

  it('serializes BEFORE finalResult so it lands inside the tool-result summary window', async () => {
    const big = 'z'.repeat(2000);
    const orch = async () => ({
      finalResult: { posts: [{ html: big }, { html: big }, { html: big }], debugTime: { lbCount: 0 } },
      steps: [], pages: []
    });
    const out = await makeRunner(orch)({ service: SERVICE, input: {}, outputSchema: SCHEMA });
    const keys = Object.keys(out.report);
    assert.ok(keys.indexOf('resultDebug') < keys.indexOf('finalResult'),
      'resultDebug must precede finalResult in key order — the engine caps the serialized report at 4000 chars');
    const s = JSON.stringify(out.report).replace(/\s+/g, ' ');
    assert.ok(s.indexOf('debugTime') < s.indexOf('"html":"zzz'), 'debug key appears before the big record strings');
  });

  it('caps per-key size and total, and stays null when finalResult has no small keys', async () => {
    const big = 'z'.repeat(2000);
    const orchA = async () => ({ finalResult: { posts: [{ a: 1 }], blob: 'y'.repeat(900), note: 'x'.repeat(900) }, steps: [], pages: [] });
    const outA = await makeRunner(orchA)({ service: SERVICE, input: {}, outputSchema: SCHEMA });
    assert.ok(outA.report.resultDebug.blob.length <= 315, 'per-key cap ~300 chars plus the truncation marker');
    const total = Object.keys(outA.report.resultDebug).reduce((n, k) => n + String(outA.report.resultDebug[k]).length, 0);
    assert.ok(total <= 1560, 'total budget bounded, got ' + total);

    const orchB = async () => ({ finalResult: { posts: [{ a: 1 }] }, steps: [], pages: [] });
    const outB = await makeRunner(orchB)({ service: SERVICE, input: {}, outputSchema: SCHEMA });
    assert.equal(outB.report.resultDebug, null, 'no small keys → null, not {}');
  });

  it('verify.run tool spec teaches the warm-tab (hot research / cold verify) divergence', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const ST = fs.readFileSync(path.join(__dirname, '..', 'lib', 'session-tools.js'), 'utf8');
    assert.match(ST, /research tab|warm/i, 'names the research-tab state');
    assert.match(ST, /fresh (load|tab|page)|cold/i, 'names the fresh/cold side');
  });
});
