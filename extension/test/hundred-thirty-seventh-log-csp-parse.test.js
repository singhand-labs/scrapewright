// extension/test/hundred-thirty-seventh-log-csp-parse.test.js
//
// 137th live log: the 136th update-time construction gate REGRESSED
// service.update in production. The wizard page's CSP (MV3 default
// `script-src 'self'`, no unsafe-eval) makes `new Function` throw an
// EvalError on EVERY script — including the trivial `return 1;` — so the
// session's every service.update was rejected STEP_SCRIPT_NOT_PARSEABLE
// (160 rejections) and the model finished at turn 64 with a correct BLOCKER
// disclosure ("a session infrastructure fault, not a scripting defect —
// probe.snippet executes identical code successfully"). The same latent bug
// sits in the 98th-round deploy gate (wizard-utils validateForExecution
// runs `new Function` in the same page context; it never fired because no
// real deploy was clicked post-98 — node tests have no CSP).
//
// Fix: the gate parses LOCALLY first (fast path, works in CSP-permissive
// contexts like node); on a CSP-flavored construction error it routes ONE
// sandbox round trip (probe.snippet — the CSP-free execution surface the
// model itself proved works) carrying a batch construction probe; only if
// the sandbox route is ALSO unavailable does it fail OPEN with a receipt
// note — an environment fault must never hard-block every update. The
// wizard-utils deploy gate gains the same CSP fail-open (warning, not
// invalid).
//
// No site tokens.
const { test, describe, it } = require('node:test');
const assert = require('assert');
const path = require('path');
const fs = require('fs');

const ST = require('../lib/session-tools');
const WU = require('../lib/wizard-utils');

const CSP_ERROR = 'Refused to evaluate a string as JavaScript because \'unsafe-eval\' is not an allowed source in the Content Security Policy';
const BAD_SCRIPT = 'const R=[/story_fbid=(\\w{8,})/,/?&]fbid=(\\d{6,})/];return {posts:R};';
const GOOD_SCRIPT = 'const R=[/story_fbid=(\\w{8,})/];return {posts:R};';

const SCHEMAS = {
  inputSchema: { type: 'object', properties: { k: { type: 'string' } } },
  outputSchema: { type: 'object', required: ['posts'], properties: { posts: { type: 'array', items: { type: 'object' } } } }
};

// A faithful mini-sandbox: executes the generated probe code with new
// Function in node (CSP-free), exactly what the real sandbox does.
function sandboxSnippet(args) {
  const code = args && args.code;
  if (typeof code !== 'string') return { error: 'no code' };
  try {
    // eslint-disable-next-line no-new-func
    const fn = new Function(code);
    return fn();
  } catch (e) {
    return { error: String((e && e.message) || e) };
  }
}

function makeDeps(opts = {}) {
  const applied = [];
  const deps = {
    rail: { executeDsl: async () => ({}), pageState: async () => ({}), epoch: 0 },
    runVerify: async () => ({ events: [], report: { ok: true, detectors: {} }, raw: {} }),
    probeFactory: () => ({
      snippet: opts.snippet || sandboxSnippet,
      count: async () => ({ count: 1 })
    }),
    getDraftService: () => null,
    applyArtifact: (a) => applied.push(a),
    getTestInput: () => ({}),
    getOutputSchema: () => ({ type: 'object', properties: {} }),
    getSteps: () => [],
    ioConfirmBridge: { request: async (p) => ({ confirmed: true, testInput: p && p.testInput }) }
  };
  if (opts.constructStepScript) deps.constructStepScript = opts.constructStepScript;
  deps.__applied = applied;
  return deps;
}

async function confirm(tools) {
  await tools['io.confirm']({ testInput: { keyword: 'ml', count: 3 }, ...SCHEMAS });
}

const step = (script) => [{ id: 's1', name: 'one', script, onSuccess: 'TERMINATE', onFailure: 'TERMINATE' }];

describe('137th log — isCspConstructError + syntaxProbeCode', () => {
  it('isCspConstructError recognizes the CSP EvalError and rejects real syntax errors', () => {
    assert.equal(WU.isCspConstructError(new EvalError(CSP_ERROR)), true);
    assert.equal(WU.isCspConstructError({ message: CSP_ERROR }), true);
    const syn = (function () { try { /* eslint-disable no-new-func */ new Function('return /?&]/'); } catch (e) { return e; } })();
    assert.ok(syn, 'sanity: the bad regex throws in node');
    assert.equal(WU.isCspConstructError(syn), false);
  });

  it('syntaxProbeCode, executed as the sandbox would, rejects the broken script with step + message', () => {
    const code = ST.syntaxProbeCode(step(BAD_SCRIPT));
    const r = sandboxSnippet({ code });
    assert.deepEqual(r, { ok: false, step: 'one', message: r.message }, 'probe names the step and the parse failure');
    assert.match(String(r.message), /Nothing to repeat|Invalid regular expression/);
  });

  it('syntaxProbeCode passes the good script', () => {
    const r = sandboxSnippet({ code: ST.syntaxProbeCode(step(GOOD_SCRIPT)) });
    assert.deepEqual(r, { ok: true });
  });
});

describe('137th log — CSP-blocked local parse falls back to the sandbox probe', () => {
  const cspConstruct = () => { throw new EvalError(CSP_ERROR); };

  it('a CSP-blocked page still REJECTS a broken script via the sandbox probe', async () => {
    const deps = makeDeps({ constructStepScript: cspConstruct });
    const tools = ST.createSessionTools(deps).tools;
    await confirm(tools);
    const r = await tools['service.update']({ steps: step(BAD_SCRIPT) });
    assert.ok(typeof r.error === 'string', 'rejected — got ' + JSON.stringify(r).slice(0, 140));
    assert.match(r.error, /STEP_SCRIPT_NOT_PARSEABLE/);
    assert.match(r.error, /one/);
    assert.match(r.error, /Nothing to repeat/);
    assert.equal(deps.__applied.length, 0);
  });

  it('a CSP-blocked page still APPLIES a good script (the gate is CSP-safe, not disabled)', async () => {
    const deps = makeDeps({ constructStepScript: cspConstruct });
    const tools = ST.createSessionTools(deps).tools;
    await confirm(tools);
    const r = await tools['service.update']({ steps: step(GOOD_SCRIPT) });
    assert.ok(r.updated === true || r.version, 'applies — got ' + JSON.stringify(r).slice(0, 140));
    assert.equal(deps.__applied.length, 1);
  });

  it('the 136th fast path (local parse in CSP-permissive contexts) is unchanged', async () => {
    const deps = makeDeps(); // no constructStepScript → local new Function (node: works)
    const tools = ST.createSessionTools(deps).tools;
    await confirm(tools);
    const bad = await tools['service.update']({ steps: step(BAD_SCRIPT) });
    assert.match(String(bad.error), /STEP_SCRIPT_NOT_PARSEABLE/);
    const good = await tools['service.update']({ steps: step(GOOD_SCRIPT) });
    assert.ok(good.updated === true || good.version);
  });

  it('sandbox probe ALSO unavailable → fail OPEN with a receipt note (an infra fault never blocks all updates)', async () => {
    const deps = makeDeps({
      constructStepScript: cspConstruct,
      snippet: async () => { throw new Error('rail unavailable'); }
    });
    const tools = ST.createSessionTools(deps).tools;
    await confirm(tools);
    const r = await tools['service.update']({ steps: step(GOOD_SCRIPT) });
    assert.ok(r.updated === true || r.version, 'applies — got ' + JSON.stringify(r).slice(0, 160));
    assert.match(String(r.parseCheckNote || r.note || JSON.stringify(r)), /parse environment unavailable|CSP/i,
      'the receipt discloses the unchecked state');
    assert.equal(deps.__applied.length, 1);
  });
});

describe('137th log — wizard deploy gate fails open on CSP (98th-round latent bug)', () => {
  it('validateForExecution treats a CSP construction error as parse-unavailable, not invalid', () => {
    const orig = global.Function;
    // inject a CSP-flavored failure through the exported seam
    const saved = WU.__testConstructStepScript;
    WU.__testConstructStepScript = () => { throw new EvalError(CSP_ERROR); };
    try {
      const r = WU.validateForExecution(step(GOOD_SCRIPT));
      assert.equal(r.valid, true, 'CSP context cannot parse — the gate must not invalidate every artifact');
      assert.ok((r.warnings || []).some((w) => /parse unavailable|CSP/i.test(w)), 'warns instead');
    } finally {
      WU.__testConstructStepScript = saved;
      global.Function = orig;
    }
  });
});
