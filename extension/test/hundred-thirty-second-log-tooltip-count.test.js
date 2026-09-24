// extension/test/hundred-thirty-second-log-tooltip-count.test.js
//
// 132nd live log: the FIRST green verify on this target was a retreat, not a
// fix, and the user called it out - "researched 80 turns and the post count
// still fell short; the timestamp hovercard was never properly triggered or
// extracted".
//
// (1) TIME GATE MIDDLE-TIER HOLE: the green artifact read postTime from the
//     page-visible labelledby text ("20 hours ago" / "September 15 at
//     12:40 PM" - exactly the incomplete source the requirement excludes),
//     probe.timestamp was called ZERO times, no full absolute was ever
//     captured - yet the gate stayed silent because ONE hovercard capture
//     carried the relative string "20 hours ago", satisfying the
//     "any date shape" tier. A relative age inside an incidental capture
//     does not establish the tooltip route. The middle tier now requires a
//     DELIBERATE time-route exercise: probe.timestamp called, or a full
//     absolute captured. The 87th-round contract (probe.timestamp called
//     with a partial/relative receipt unlocks the disclosed ship) is
//     unchanged.
//
// (2) TEST-INPUT DOWNGRADE INVISIBILITY: the count shortfall was resolved by
//     renegotiating the test input from count=5 to count=3 - the confirm
//     panel showed a normal contract, not a RETREAT. Numeric downgrades
//     against the previously confirmed testInput are now disclosed in the
//     panel note and the receipt.
//
// (3) HOVER COST TEACHING: the model hovered multi-anchor unions (5-10s per
//     anchor per card), timed out a 90s snippet four times, then abandoned
//     the hover route entirely. The spec now teaches narrowing the anchorSel
//     union to the one anchor the hover-derived field needs, and the
//     snippet-timeout error says so too.
//
// (4) COUNT-BOUNDED SCROLL DEFAULT: three sessions hand-rolled scroll polls
//     (round 130 froze at 2, round 131 shipped 4/5, round 132 retreated to
//     count=3) while $collectUntil - the primitive with settle, unique
//     counting, inner-container probing and certified exhaustion - sat
//     unused. The scroll teaching now names it the DEFAULT for
//     count-bounded feeds.
//
// No site tokens.
const { test, describe, it } = require('node:test');
const assert = require('assert');
const fs = require('fs');
const path = require('path');
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
function orchWithEvents(finalResult, eventsToEmit) {
  return async (service, input, d3, hooks) => {
    const emit = (hooks && typeof hooks.onEvent === 'function')
      ? hooks.onEvent
      : ((d3 && typeof d3.onEvent === 'function') ? d3.onEvent : () => {});
    for (const evt of (eventsToEmit || [])) {
      try { emit(evt); } catch (e) { /* harness */ }
    }
    return {
      finalResult,
      steps: [{ stepId: 's1', stepName: 'one', result: { done: true }, snapshot: null }],
      pages: [], pagesTruncated: false
    };
  };
}
const SERVICE = { targetUrl: 'https://example.com', steps: [{ id: 's1', name: 'one', script: 'return 1', onSuccess: 'TERMINATE' }], config: {} };
const REQ_TIME_SCHEMA = {
  type: 'object', required: ['posts'],
  properties: { posts: { type: 'array', items: { type: 'object', required: ['postTime'], properties: { postTime: { type: 'string' } } } } }
};

describe('132nd log — TIME gate: relative-only captures do not establish the route', () => {
  it('relative-shaped capture + NO probe.timestamp + required relative field → RED naming the deliberate-route requirement', async () => {
    const runner = makeRunner(orchWithEvents(
      { posts: [{ postTime: '20 hours ago' }, { postTime: 'a day ago' }] },
      [{ type: 'STEP_ITERATION', stepId: 's1', resultPreview: '{"done":true}',
         selectorDiagnostics: [{ api: 'extractWithHover', containerSelector: 'div.card', capturedPopovers: { captured: 1, samples: ['20 hours ago'] } }] }]
    ));
    const out = await runner({
      service: SERVICE, input: {}, outputSchema: REQ_TIME_SCHEMA,
      sessionEvidence: { probeTimestampCalls: 0, lastFullAbsolute: false, popoverSamples: [] }
    });
    assert.equal(out.report.ok, false, 'an incidental relative capture is not route evidence');
    assert.match(out.report.error.message, /TIME_SOURCE_UNEXERCISED/);
    assert.match(out.report.error.message, /relative\/partial/i, 'names what the captures actually hold');
    assert.match(out.report.error.message, /probe\.timestamp/, 'teaches the deliberate probe');
    assert.match(out.report.error.message, /hoverPopover/, 'teaches the rejected-mount channel');
  });

  it('the 87th contract stands: probe.timestamp CALLED with a partial receipt still unlocks the disclosed ship', async () => {
    const runner = makeRunner(orchWithEvents(
      { posts: [{ postTime: '20 hours ago' }, { postTime: 'a day ago' }] },
      [{ type: 'STEP_ITERATION', stepId: 's1', resultPreview: '{"done":true}',
         selectorDiagnostics: [{ api: 'extractWithHover', containerSelector: 'div.card', capturedPopovers: { captured: 1, samples: ['20 hours ago'] } }] }]
    ));
    const out = await runner({
      service: SERVICE, input: {}, outputSchema: REQ_TIME_SCHEMA,
      sessionEvidence: { probeTimestampCalls: 1, lastFullAbsolute: false, popoverSamples: [] }
    });
    assert.equal(out.report.ok, true, 'deliberate route exercise + partial receipt = legal disclosed ship');
    assert.equal(out.report.events.indexOf('TIME_SOURCE_UNEXERCISED'), -1);
  });

  it('a captured FULL absolute still exempts the run outright', async () => {
    const runner = makeRunner(orchWithEvents(
      { posts: [{ postTime: '20 hours ago' }, { postTime: 'a day ago' }] }, []
    ));
    const out = await runner({
      service: SERVICE, input: {}, outputSchema: REQ_TIME_SCHEMA,
      sessionEvidence: { probeTimestampCalls: 0, lastFullAbsolute: false, popoverSamples: ['Tuesday, September 22, 2026 at 8:14 PM'] }
    });
    assert.equal(out.report.ok, true);
    assert.equal(out.report.events.indexOf('TIME_SOURCE_UNEXERCISED'), -1);
    const lane = out.report.detectors.timeAbsoluteCapturedUnbound;
    assert.ok(Array.isArray(lane) && lane.length === 1, 'the captured-absolute advisory still names the bind route');
  });

  it('captures with NO date shape keep the truthful captured-no-date red', async () => {
    const runner = makeRunner(orchWithEvents(
      { posts: [{ postTime: '4 days ago' }, { postTime: '3 days ago' }] },
      [{ type: 'STEP_ITERATION', stepId: 's1', resultPreview: '{"done":true}',
         selectorDiagnostics: [{ api: 'extractWithHover', containerSelector: 'div.card', capturedPopovers: { captured: 2, samples: ['CoderMind Lab · 18K Followers'] } }] }]
    ));
    const out = await runner({
      service: SERVICE, input: {}, outputSchema: REQ_TIME_SCHEMA,
      sessionEvidence: { probeTimestampCalls: 0, lastFullAbsolute: false, popoverSamples: [] }
    });
    assert.equal(out.report.ok, false);
    assert.match(out.report.error.message, /ANY date shape/i);
  });
});

describe('132nd log — testInput downgrade disclosed at the confirm panel', () => {
  const { createSessionTools } = require('../lib/session-tools');
  function makeDeps(capture) {
    return {
      rail: { executeDsl: async () => ({ result: [] }) },
      runVerify: async () => ({ events: [], report: { ok: true, detectors: {} }, raw: {} }),
      probeFactory: () => ({ snippet: async () => ({ result: 'ok' }) }),
      getDraftService: () => null,
      applyArtifact: async () => ({ ok: true }),
      getTestInput: () => ({}),
      getOutputSchema: () => null,
      getSteps: () => [],
      ioConfirmBridge: { request: async (p) => { if (capture) capture(p); return { confirmed: true, testInput: p && p.testInput }; } }
    };
  }
  const SCHEMAS = {
    inputSchema: { type: 'object', required: ['keyword', 'count'], properties: { keyword: { type: 'string' }, count: { type: 'number' } } },
    outputSchema: { type: 'object', required: ['posts'], properties: { posts: { type: 'array', items: { type: 'object' } } } }
  };

  it('proposing count=3 after count=5 was confirmed carries the downgrade in the panel payload and the receipt', async () => {
    const panels = [];
    const tools = createSessionTools(makeDeps((p) => { panels.push(p); }));
    await tools.tools['io.confirm'](Object.assign({ testInput: { keyword: 'ml', count: 5 } }, SCHEMAS));
    assert.equal(panels.length, 1);
    const r2 = await tools.tools['io.confirm'](Object.assign({ testInput: { keyword: 'ml', count: 3 }, note: 'feed offered fewer cards' }, SCHEMAS));
    assert.equal(panels.length, 2, 'a changed testInput pops the panel again');
    const p2 = panels[1];
    assert.ok(Array.isArray(p2.testInputDowngrades) && p2.testInputDowngrades.length === 1,
      'structured downgrade rides the panel payload — got ' + JSON.stringify(p2.testInputDowngrades));
    assert.match(String(p2.testInputDowngrades[0]), /count: 5 → 3/);
    assert.match(String(r2.note || '') + String(panels[1].note || ''), /LOWERING count: 5 → 3/i, 'the downgrade is human-readable');
  });

  it('raising or keeping the value carries no downgrade marker', async () => {
    const panels = [];
    const tools = createSessionTools(makeDeps((p) => { panels.push(p); }));
    await tools.tools['io.confirm'](Object.assign({ testInput: { keyword: 'ml', count: 3 } }, SCHEMAS));
    const r2 = await tools.tools['io.confirm'](Object.assign({ testInput: { keyword: 'ml', count: 8 } }, SCHEMAS));
    assert.equal((panels[1].testInputDowngrades || []).length, 0, 'an increase is not a downgrade');
    assert.doesNotMatch(JSON.stringify(r2), /downgrad/i);
  });
});

describe('132nd log — teaching: anchor-cost, snippet-timeout, scroll default', () => {
  it('the $extractWithHover DSL bullet teaches narrowing the anchorSel union (each member costs a hover cycle per card)', () => {
    const st = fs.readFileSync(path.join(__dirname, '../lib/session-tools.js'), 'utf8');
    const i = st.indexOf("- $extractWithHover(containerSel");
    assert.ok(i > -1, 'DSL bullet found');
    const bullet = st.slice(i, i + 4200);
    assert.match(bullet, /narrow the anchorSel union/i);
    assert.match(bullet, /one anchor per card/i);
    assert.match(bullet, /bind the value via read:.{0,4}hoverPopover/, 'names the rejected-mount bind channel');
  });

  it('the snippet-timeout error teaches anchor-union narrowing beside maxContainers', () => {
    const pt = fs.readFileSync(path.join(__dirname, '../lib/probe-tools.js'), 'utf8');
    const i = pt.indexOf('snippet exceeded');
    assert.ok(i > -1);
    assert.match(pt.slice(i, i + 500), /anchorSel/i, 'the timeout error names the anchor lever');
  });

  it('scroll teaching names $collectUntil as the DEFAULT for count-bounded feeds (research $ API + DSL guide)', () => {
    const st = fs.readFileSync(path.join(__dirname, '../lib/session-tools.js'), 'utf8');
    const wu = fs.readFileSync(path.join(__dirname, '../lib/wizard-utils.js'), 'utf8');
    const iSt = st.indexOf("- $scrollBy(px)");
    const iWu = wu.indexOf('SCROLL-COLLECT RELIABILITY');
    assert.ok(iSt > -1 && iWu > -1, 'both scroll-teaching sites found');
    assert.match(st.slice(iSt, iSt + 900), /\$collectUntil\(containerSel, \{targetCount: N, idAttr\}\) is the DEFAULT/i,
      'the research-side scroll bullet no longer teaches the hand-rolled poll as the default');
    assert.match(wu.slice(iWu, iWu + 900), /\$collectUntil/i, 'DSL guide keeps the collect-until reliability block');
  });
});
