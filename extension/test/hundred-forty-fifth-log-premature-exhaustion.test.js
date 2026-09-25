// extension/test/hundred-forty-fifth-log-premature-exhaustion.test.js
//
// 145th log: the session shipped a GREEN artifact delivering 1 of 10
// requested posts. The collect step's script ended with
// `return {done: n2 >= __input__.count || n2 === n, n: n2}` — done after ONE
// no-growth round: on the cold verify tab the first 900px scroll + 1500ms
// settle had not yet mounted lazy content (n2 === n === 1), so the loop
// exited at 1/10 with a self-declared "done". This is the 39th/23rd class
// (single-round no-growth proves nothing on a cold tab), the seventh
// recurrence, now via a HAND-ROLLED loop that bypassed every $collectUntil
// bar — and the model then misdiagnosed the shortfall as "supply scarcity,
// try another keyword" (the same keyword delivered 7 posts the day before).
//
// Fix under test: PREMATURE_EXHAUSTION veto — a SEVERE record-count
// shortfall with NO certified-exhaustion receipt, where a scroll-API step
// (no $collectUntil) exited done:true after ≤3 iterations with its counter
// below the ask, is RED with the exits spelled out (certify with
// $collectUntil or the sustained-stall bar).
//
// No site tokens.
const { test, describe, it } = require('node:test');
const assert = require('assert');
const { createVerifyRunner } = require('../lib/verify-runner');

function makeRunner(orch, overrides) {
  const calls = [];
  const deps = Object.assign({
    ensureLock: async () => {},
    releaseLock: async () => {},
    createTab: async () => ({ id: 1 }),
    removeTab: async () => {},
    waitForTabLoad: async () => {},
    sendMessage: async () => ({ pong: true }),
    executeScript: async () => ({ result: 'ok', selectorDiagnostics: [] }),
    captureSnapshot: async () => ({ html: '<html></html>' }),
    evaluateCondition: async () => true,
    orchestrate: orch
  }, overrides || {});
  return { runner: createVerifyRunner(deps), calls, deps };
}

const SCHEMA = { type: 'object', required: ['posts'], properties: { posts: { type: 'array', items: { type: 'object' } } } };

const INCIDENT_SERVICE = {
  targetUrl: 'https://example.com/search?q=x',
  steps: [
    { id: 'collect', name: 'scroll collect', script: 'const C=".card";let n=await $count(C);if(n>=__input__.count)return{done:true,n};await $scrollBy(900);await new Promise(r=>setTimeout(r,1500));let n2=await $count(C);return{done:n2>=__input__.count||n2===n,n:n2};', onSuccess: 'extract', maxIterations: 40 },
    { id: 'extract', name: 'extract', script: 'return {done:true, posts: await $list(".card")};', onSuccess: 'TERMINATE' }
  ],
  config: {}
};

const ONE_POST = [{ a: 1 }];

function incidentOrch(previews) {
  return async (svc, input, d, opts) => {
    await d.createTab(svc.targetUrl);
    opts.onEvent({ type: 'EXECUTION_START' });
    let i = 0;
    for (const pv of previews) {
      opts.onEvent({ type: 'STEP_ITERATION', stepId: 'collect', iteration: ++i, resultPreview: pv });
    }
    opts.onEvent({ type: 'STEP_ITERATION', stepId: 'extract', iteration: 1, resultPreview: '{"done":true,"posts":[...]}' });
    return { finalResult: { posts: ONE_POST }, steps: [], pages: [], pagesTruncated: false };
  };
}

describe('145th log — PREMATURE_EXHAUSTION veto', () => {
  it('the incident shape (1 iteration, done:true, n=1 vs count=10) is RED with the exits named', async () => {
    const { runner } = makeRunner(incidentOrch(['{"done":true,"n":1}']));
    const out = await runner({ service: INCIDENT_SERVICE, input: { count: 10 }, outputSchema: SCHEMA });
    assert.equal(out.report.ok, false);
    assert.match(out.report.error.message, /PREMATURE_EXHAUSTION/);
    assert.match(out.report.error.message, /"collect"/);
    assert.match(out.report.error.message, /\$collectUntil/);
    assert.match(out.report.error.message, /proves nothing|no-growth/i);
  });

  it('a certified-exhaustion receipt in a step preview does NOT veto (the sanctioned disclosed-shortfall exit stays green)', async () => {
    const { runner } = makeRunner(incidentOrch(['{"done":true,"n":1,"exhaustion":{"certified":true}}']));
    const out = await runner({ service: INCIDENT_SERVICE, input: { count: 10 }, outputSchema: SCHEMA });
    assert.equal(out.report.ok, true, 'certified shortfall ships green-disclosed — got ' + JSON.stringify(out.report.error || {}).slice(0, 140));
    assert.ok(out.report.detectors.countShortfall, 'the shortfall is still disclosed');
    assert.equal(out.report.detectors.countShortfall.exhaustionCertified, true);
  });

  it('a step that SUSTAINED its poll (5 iterations, then done) is not premature — no veto despite the severe shortfall', async () => {
    const { runner } = makeRunner(incidentOrch(['{"done":false,"n":1}', '{"done":false,"n":1}', '{"done":false,"n":2}', '{"done":false,"n":2}', '{"done":true,"n":2}']));
    const out = await runner({ service: INCIDENT_SERVICE, input: { count: 10 }, outputSchema: SCHEMA });
    assert.equal(out.report.ok, true, 'sustained polling exhausted honestly — got ' + JSON.stringify(out.report.error || {}).slice(0, 140));
    assert.equal(out.report.detectors.countShortfall.exhaustionCertified, false, 'still NOT certified — the disclosed caveat stands');
  });

  it('a $collectUntil-using artifact is exempt (the primitive carries its own sustained bar and certification)', async () => {
    const svc = JSON.parse(JSON.stringify(INCIDENT_SERVICE));
    svc.steps[0].script = 'const r = await $collectUntil(".card", {targetCount: __input__.count, idAttr: "href"}); return {done:true, n: r.finalCount};';
    const { runner } = makeRunner(incidentOrch(['{"done":true,"n":1}']));
    const out = await runner({ service: svc, input: { count: 10 }, outputSchema: SCHEMA });
    assert.equal(out.report.ok, true, 'the primitive\'s own verdict governs — got ' + JSON.stringify(out.report.error || {}).slice(0, 140));
  });

  it('no shortfall (count met) never trips the veto', async () => {
    const orch = async (svc, input, d, opts) => {
      await d.createTab(svc.targetUrl);
      opts.onEvent({ type: 'EXECUTION_START' });
      opts.onEvent({ type: 'STEP_ITERATION', stepId: 'collect', iteration: 1, resultPreview: '{"done":true,"n":10}' });
      opts.onEvent({ type: 'STEP_ITERATION', stepId: 'extract', iteration: 1, resultPreview: '{"done":true,"posts":[...]}' });
      return { finalResult: { posts: Array.from({ length: 10 }, (_, i) => ({ a: i })) }, steps: [], pages: [], pagesTruncated: false };
    };
    const { runner } = makeRunner(orch);
    const out = await runner({ service: INCIDENT_SERVICE, input: { count: 10 }, outputSchema: SCHEMA });
    assert.equal(out.report.ok, true);
    assert.equal(out.report.detectors.countShortfall, null);
  });
});
