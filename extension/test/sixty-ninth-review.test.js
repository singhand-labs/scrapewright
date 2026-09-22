// extension/test/sixty-ninth-review.test.js
// Sixty-ninth review fixes — F1 (probe timeoutMs through the rail), F2 (TS
// shared hover budget recharge + note fidelity), F7 (io.confirm prefill
// shape-key / explicit-empty), F10 (repeated-failure tracker hardening),
// F11 (queue-wait disclosure), F13 (awaitingUser), F14 (supersede note
// propagation), F15 (❓ title linger).
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');
const { createProbeTools } = require('../lib/probe-tools');
const { createSessionTools } = require('../lib/session-tools');
const { createResearchSession } = require('../lib/research-session');

const SRC = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
function sliceFn(src, a, b) {
  const s = src.indexOf(a); assert.ok(s > -1, 'marker ' + a);
  const e = src.indexOf(b, s); assert.ok(e > s, 'end ' + b);
  return src.slice(s, e);
}

// ---------------------------------------------------------------------------
// F1: probe timeoutMs actually reaches the rail/executor
describe('F1: probe.snippet timeoutMs propagation', () => {
  it('runSnippetWithTimeout passes {timeoutMs} through to executeDsl', async () => {
    let seenOpts = null;
    const tools = createProbeTools({ executeDsl: async (snippet, opts) => { seenOpts = opts; return 1; } });
    await tools.snippet({ code: 'return 1;', timeoutMs: 60000 });
    assert.ok(seenOpts && typeof seenOpts === 'object', 'opts forwarded');
    assert.equal(seenOpts.timeoutMs, 60000);
  });
  it('no timeoutMs → the default 30000 rides opts (rail still receives an explicit budget)', async () => {
    let seenOpts = null;
    const tools = createProbeTools({ executeDsl: async (s, opts) => { seenOpts = opts; return 1; } });
    await tools.snippet({ code: 'return 1;' });
    assert.equal(seenOpts && seenOpts.timeoutMs, 30000);
  });
  it('source audit: live-rail forwards opts; wizard execute honors opts.timeoutMs (≤90s)', () => {
    const lr = SRC('lib/live-rail.js');
    assert.match(lr, /d\.execute\(currentTab\.id, snippet, opts\)/, 'rail forwards opts');
    const wz = SRC('wizard.js');
    const m = wz.match(/execute: async \(tabId, snippet, opts\) =>[\s\S]{0,600}?executor\.timeoutMs[^\n]*/);
    assert.ok(m, 'wizard execute sets timeoutMs from opts');
    assert.match(m[0], /opts\.timeoutMs/, 'reads opts.timeoutMs');
    assert.match(m[0], /90000/, 'capped at 90s');
  });
});

// ---------------------------------------------------------------------------
// F11: queue-wait disclosure on the serialized probe rail
describe('F11: queue-wait disclosure', () => {
  it('a probe that times out after queueing behind a slow predecessor discloses the wait', async () => {
    // Call 1 occupies the rail for ~2.5s (the "previous probe"); call 2
    // enters immediately, waits its turn, then blows its (tiny) own budget.
    const tools = createProbeTools({
      executeDsl: async (snippet, opts) => {
        if (snippet.includes('SLOW')) {
          await new Promise((r) => setTimeout(r, 2500));
          return 1;
        }
        await new Promise((r) => setTimeout(r, 300));
        return 2;
      }
    });
    const p1 = tools.snippet({ code: 'return "SLOW";' });
    const p2 = tools.snippet({ code: 'return 2;', timeoutMs: 100 });
    const r2 = await p2;
    await p1;
    assert.ok(r2 && typeof r2.error === 'string', 'call 2 timed out');
    assert.match(r2.error, /waiting behind the previous probe on the serialized rail/, 'queue wait disclosed');
    assert.match(r2.error, /snippet exceeded 100ms/, 'timeoutMs knob still named');
  });
});

// ---------------------------------------------------------------------------
// F2: TS shared hover budget — recharge on href change + note fidelity
describe('F2: TS shared hover budget', () => {
  function loadTs(budgetMs) {
    const CS = SRC('content-script.js');
    let TS_SLICE = sliceFn(CS, 'var TS_MAX_HOVER_ANCHORS', '\n  async function domExists(');
    // test-only surgery: shrink the budget so depletion is observable in ms
    TS_SLICE = TS_SLICE.replace('var TS_HOVER_BUDGET_FULL_MS = 30000;', 'var TS_HOVER_BUDGET_FULL_MS = ' + budgetMs + ';');
    assert.ok(TS_SLICE.includes('TS_HOVER_BUDGET_FULL_MS = ' + budgetMs), 'surgery applied');
    const HARVEST = sliceFn(CS, 'function harvestAnchorLabel(', '\n  async function domHover(');
    const dom = new JSDOM('<div id="card"><a class="ts" href="?x">3 days ago</a><a class="t2" href="?y">4 days ago</a></div>', { url: 'https://e.com/p' });
    const card = dom.window.document.getElementById('card');
    const ctx = {
      document: dom.window.document,
      querySelectorAllDeep: (sel) => (sel === '#card' ? [card] : []),
      notifyBackgroundDiagnostic: () => {}, sendDebugLog: () => {},
      domHover: async () => ({ hovered: false, htmlSnippet: null })
    };
    vm.createContext(ctx);
    vm.runInContext(HARVEST + '\n' + TS_SLICE + '\nthis.__ts = domTimestamp;', ctx);
    return { ts: ctx.__ts, ctx };
  }
  it('prior-call exhaustion blames earlier calls (dwell charges 1ms each)', async () => {
    // budget 2, two anchors: call 1 spends 2 (exhausted on itself); call 2
    // finds the budget at 0 with prior spend > 0 → blames earlier calls.
    const { ts } = loadTs(2);
    const r1 = await ts('#card', { anchorSel: '.ts,.t2' });
    assert.ok(r1.result.note && /shared hover budget/.test(r1.result.note), 'call 1 exhausted');
    const r2 = await ts('#card', { anchorSel: '.ts,.t2' });
    assert.ok(r2.result.note && /shared hover budget/.test(r2.result.note), 'call 2 exhausted');
    assert.match(r2.result.note, /earlier \$timestamp calls/, 'traces to prior calls');
    assert.match(r2.result.note, /labels are still harvested without hovering/, 'harvest teaching');
    assert.match(r2.result.note, /budget recharges when the page navigates/, 'recharge teaching');
  });
  it('first-call exhaustion names the card itself, not earlier calls', async () => {
    const { ts } = loadTs(1); // one dwell kills the whole budget
    const r = await ts('#card', { anchorSel: '.ts,.t2' });
    assert.ok(r.result.note && /shared hover budget/.test(r.result.note), 'exhausted on the first call');
    assert.match(r.result.note, /this card's own anchors exhausted/, 'first call blames itself');
    assert.doesNotMatch(r.result.note, /earlier \$timestamp calls/);
  });
  it('a location.href change recharges the budget', async () => {
    // budget 1: two anchors guarantee the pre-hover budget check trips
    // (charge ≥1 per dwell), and a single-anchor post-recharge call cannot.
    const { ts, ctx } = loadTs(1);
    const r1 = await ts('#card', { anchorSel: '.ts,.t2' });
    assert.ok(r1.result.note && /shared hover budget/.test(r1.result.note), 'depleted');
    ctx.location = { href: 'https://e.com/other-route' }; // SPA navigation
    const r2 = await ts('#card', { anchorSel: '.ts' }); // one anchor, one dwell
    assert.ok(!(r2.result.note && /shared hover budget/.test(r2.result.note)), 'budget recharged after href change');
  });
});

// ---------------------------------------------------------------------------
// F7: io.confirm prefill holes
function sessionDeps(bridgeImpl, getTestInput) {
  const state = { draft: null };
  return {
    rail: {
      pageOpen: async () => ({ tabId: 1, url: 'https://example.com', ready: true }),
      pageState: async () => ({}),
      executeDsl: async () => 1,
      ensureLock: async () => {}, releaseLock: async () => {}, dispose: async () => {}, tabId: 1
    },
    runVerify: async () => ({}),
    getDraftService: () => state.draft,
    applyArtifact: (a) => { state.draft = { steps: a.steps, testInput: a.testInput, inputSchema: a.inputSchema, outputSchema: a.outputSchema }; },
    getTestInput: () => (getTestInput ? getTestInput() : null),
    getOutputSchema: () => null,
    getSteps: () => [],
    annotationBridge: null,
    ioConfirmBridge: bridgeImpl
  };
}
const IN_KW = { type: 'object', required: ['keyword'], properties: { keyword: { type: 'string' } } };
const IN_Q = { type: 'object', required: ['query'], properties: { query: { type: 'string' } } };
const OUT = { type: 'object', required: ['posts'], properties: { posts: { type: 'array', items: { type: 'object' } } } };

describe('F7: io.confirm prefill', () => {
  async function confirmOnce() {
    const reqs = [];
    const t = createSessionTools(sessionDeps({ request: async (r) => { reqs.push(r); return { confirmed: true }; } }));
    await t.tools['io.confirm']({ inputSchema: IN_KW, outputSchema: OUT, testInput: { keyword: 'ml' } });
    return { t, reqs };
  }
  it('renegotiated input shape → NO stale prefill from prior confirmed values', async () => {
    const { t, reqs } = await confirmOnce();
    await t.tools['io.confirm']({ inputSchema: IN_Q, outputSchema: OUT });
    const second = reqs[reqs.length - 1];
    assert.deepEqual(second.testInput, {}, 'shape mismatch → no prior-keyword prefill');
  });
  it('same input shape → prior confirmed values prefill', async () => {
    const { t, reqs } = await confirmOnce();
    await t.tools['io.confirm']({ inputSchema: IN_KW, outputSchema: OUT });
    const second = reqs[reqs.length - 1];
    assert.deepEqual(second.testInput, { keyword: 'ml' }, 'same shape → prior values prefill');
  });
  it('explicit {} with a NON-empty schema is treated as omitted (prior values used)', async () => {
    const { t, reqs } = await confirmOnce();
    await t.tools['io.confirm']({ inputSchema: IN_KW, outputSchema: OUT, testInput: {} });
    const second = reqs[reqs.length - 1];
    assert.deepEqual(second.testInput, { keyword: 'ml' }, 'explicit {} → prior TI chain');
  });
  it('{} stays the proposal for a genuinely parameterless schema', async () => {
    const reqs = [];
    const t = createSessionTools(sessionDeps({ request: async (r) => { reqs.push(r); return { confirmed: true }; } }));
    await t.tools['io.confirm']({ inputSchema: { type: 'object', properties: {} }, outputSchema: OUT, testInput: {} });
    assert.deepEqual(reqs[0].testInput, {});
  });
  it('source audit: wizard substitutes only when the proposal omitted testInput, and annotates', () => {
    const wz = SRC('wizard.js');
    assert.match(wz, /testInputProvided/, 'bridge carries the provided flag');
    assert.match(wz, /prefilled from the last confirmed values/, 'substitution annotated in the panel');
  });
});

// ---------------------------------------------------------------------------
// F10: repeated-failure tracker hardening (engine-level, scripted LLM)
describe('F10: repeated-failure tracker', () => {
  function railAlwaysError(msg) {
    return {
      pageOpen: async () => ({ tabId: 1, url: 'u', ready: true }),
      pageState: async () => ({ open: true, tabId: 1, url: 'u' }),
      executeDsl: async () => ({ error: msg }),
      ensureLock: async () => {}, releaseLock: async () => {}, dispose: async () => {}, tabId: 1
    };
  }
  function baseTools(rail) {
    return createSessionTools({
      rail,
      runVerify: async () => ({}),
      getDraftService: () => null,
      applyArtifact: () => {},
      getTestInput: () => ({}),
      getOutputSchema: () => null,
      getSteps: () => [],
      annotationBridge: null,
      ioConfirmBridge: { request: async () => ({ confirmed: true }) }
    });
  }
  async function drive(turns) {
    let i = 0;
    const llm = async () => ({ content: JSON.stringify(turns[i++]), finish_reason: 'stop' });
    const rail = railAlwaysError('selector rejected by harness: no receipts for that shape');
    const tools = baseTools(rail);
    const session = createResearchSession({
      requirement: 'r', llm, tools: tools.tools, toolSpecs: tools.toolSpecs,
      systemPrompt: tools.systemPromptBase, knowledge: { units: [], index: [] },
      budgets: { maxTurns: 20 }, retry: { attempts: 1 }
    });
    tools.bindEngine(session);
    const report = await session.run();
    const st = session.state();
    const nudges = st.session.transcript.filter((e) => e.kind === 'system' && /REPEATED IDENTICAL FAILURE/.test(e.text || ''));
    return { report, nudges, st };
  }
  it('reordered-args identical failures fire the nudge (canonical callKey)', async () => {
    const { nudges } = await drive([
      { think: 'a', tool: 'probe.snippet', args: { code: 'no return here', timeoutMs: 5000 } },
      { think: 'b', tool: 'probe.snippet', args: { timeoutMs: 5000, code: 'no return here' } },
      { finish: { summary: 'done' } }
    ]);
    assert.ok(nudges.length >= 1, 'key-order difference is the SAME call — nudge fires');
  });
  it('transient-signature repeats never fire (retryable by teaching)', async () => {
    const rail = railAlwaysError('transient network blip — retry');
    let i = 0;
    const turns = [
      { think: 'a', tool: 'probe.snippet', args: { code: 'return 1;' } },
      { think: 'b', tool: 'probe.snippet', args: { code: 'return 1;' } },
      { think: 'c', tool: 'probe.snippet', args: { code: 'return 1;' } },
      { finish: { summary: 'done' } }
    ];
    const llm = async () => ({ content: JSON.stringify(turns[i++]), finish_reason: 'stop' });
    const tools = baseTools(rail);
    const session = createResearchSession({
      requirement: 'r', llm, tools: tools.tools, toolSpecs: tools.toolSpecs,
      systemPrompt: tools.systemPromptBase, knowledge: { units: [], index: [] },
      budgets: { maxTurns: 20 }, retry: { attempts: 1 }
    });
    tools.bindEngine(session);
    await session.run();
    const st = session.state();
    const nudges = st.session.transcript.filter((e) => e.kind === 'system' && /REPEATED IDENTICAL FAILURE/.test(e.text || ''));
    assert.equal(nudges.length, 0, 'transient repeats are taught retryable, not shape-change');
  });
  it('A-B-A non-consecutive repeat within 3 failing calls fires', async () => {
    const { nudges } = await drive([
      { think: 'a', tool: 'probe.snippet', args: { code: 'no return A' } },
      { think: 'b', tool: 'probe.snippet', args: { code: 'no return B' } },
      { think: 'a2', tool: 'probe.snippet', args: { code: 'no return A' } },
      { finish: { summary: 'done' } }
    ]);
    assert.ok(nudges.length >= 1, 'non-consecutive repeat in the ring fires');
  });
});

// ---------------------------------------------------------------------------
// F13: awaitingUser park descriptor
describe('F13: awaitingUser', () => {
  it('a parked user.observe carries {kind, question} into state(); resolved parks clear it', async () => {
    let release = null;
    const tools = createSessionTools(sessionDeps(
      { request: async () => new Promise((res) => { release = res; }) },
      () => ({})
    ));
    tools.observeBridgeOverride = null;
    // wire the observe bridge through the deps? session-tools reads
    // d.observeBridge — build a fresh tools instance with it.
    const reqs = [];
    const t2 = createSessionTools(Object.assign(sessionDeps({ request: async () => ({ confirmed: true }) }, () => ({})), {
      observeBridge: { request: () => new Promise((res) => { reqs.push(res); }) }
    }));
    let i = 0;
    const turns = [
      { think: 'ask', tool: 'user.observe', args: { question: 'does a tooltip appear?' } },
      { finish: { summary: 'done' } }
    ];
    const llm = async () => ({ content: JSON.stringify(turns[i++]), finish_reason: 'stop' });
    const session = createResearchSession({
      requirement: 'r', llm, tools: t2.tools, toolSpecs: t2.toolSpecs,
      systemPrompt: t2.systemPromptBase, knowledge: { units: [], index: [] },
      budgets: { maxTurns: 20 }, retry: { attempts: 1 }
    });
    t2.bindEngine(session);
    const runP = session.run();
    // let the engine reach the parked bridge
    await new Promise((r) => setTimeout(r, 150));
    const mid = session.state();
    assert.ok(mid.awaitingUser, 'parked session exposes awaitingUser');
    assert.equal(mid.awaitingUser.kind, 'user.observe');
    assert.match(mid.awaitingUser.question, /tooltip/);
    reqs[0]({ answer: 'yes it does' });
    const report = await runP;
    const end = session.state();
    assert.ok(!end.awaitingUser, 'parkEnd clears awaitingUser');
    assert.equal(report.stopped && report.stopped.reason, 'completed');
  });
  it('source audit: parkBegin carries a descriptor; stateForPersist includes awaitingUser', () => {
    const rs = SRC('lib/research-session.js');
    assert.match(rs, /function parkBegin\(kind, question\)/, 'descriptor params');
    assert.match(rs, /out\.awaitingUser = awaitingUser/, 'persisted');
    const st = SRC('lib/session-tools.js');
    assert.match(st, /parkBegin\('io\.confirm'/);
    assert.match(st, /parkBegin\('user\.observe'/);
    assert.match(st, /parkBegin\('annotate\.request'/);
  });
});

// ---------------------------------------------------------------------------
// F14: supersede note propagation
describe('F14: userObserve cancel note', () => {
  it('bridge cancel with a note propagates it; without one the default teaching stays', async () => {
    const mk = (res) => createSessionTools(sessionDeps({ request: async () => ({ confirmed: true }) }, () => ({})));
    const t1 = createSessionTools(Object.assign(sessionDeps({ request: async () => ({ confirmed: true }) }, () => ({})), {
      observeBridge: { request: async () => ({ cancelled: true, note: 'superseded' }) }
    }));
    const r1 = await t1.tools['user.observe']({ question: 'q?' });
    assert.equal(r1.cancelled, true);
    assert.equal(r1.note, 'superseded', 'bridge note wins');
    const t2 = createSessionTools(Object.assign(sessionDeps({ request: async () => ({ confirmed: true }) }, () => ({})), {
      observeBridge: { request: async () => ({ cancelled: true }) }
    }));
    const r2 = await t2.tools['user.observe']({ question: 'q?' });
    assert.match(r2.note, /user dismissed/, 'default teaching when no note');
  });
});

// ---------------------------------------------------------------------------
// F15: ❓ title linger
describe('F15: title restore after panel close', () => {
  it('source audit: badgeAfterPanelClose restores the base title when nothing is waiting', () => {
    const wz = SRC('wizard.js');
    const m = wz.match(/function badgeAfterPanelClose\(\)[\s\S]{0,900}?\n\}/);
    assert.ok(m, 'fn found');
    assert.match(m[0], /BASE_DOC_TITLE/, 'title restored');
    assert.match(m[0], /is-waiting/, 'a waiting badge may keep the title');
    assert.match(m[0], /sessionPanelOpen\(\)/, 'panels checked');
  });
});
