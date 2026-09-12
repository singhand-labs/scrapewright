// Sixty-eighth log follow-ups (91-turn green session, three harness gaps):
// F1 probe.snippet timeoutMs knob (default 30000, cap 90000, error names
//     the knob; the rail takes no budget arg, so a client-side race wraps
//     executeDsl);
// F2 repeated-identical-failure nudge (2nd consecutive same-tool/same-args/
//     same-error-prefix failure pushes ONE system transcript note);
// F3 parked-ask tab-title visibility (waiting badge → '❓ your answer is
//     needed' title + one +5min reminder toast);
// F4 io.confirm testInput prefill chain (proposal → artifact values →
//     session-confirmed values; never bless EMPTY when prior values exist).
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { createProbeTools } = require('../lib/probe-tools');
const { createSessionTools } = require('../lib/session-tools');
const { createResearchSession } = require('../lib/research-session');

const WIZARD_SRC = fs.readFileSync(path.join(__dirname, '..', 'wizard.js'), 'utf8');

function reply(content) {
  return { content, finish_reason: 'stop', usage: { prompt_tokens: 100, completion_tokens: 10 } };
}
function envelope(tool, args) {
  return JSON.stringify({ think: 't', tool, args: args || {} });
}
function finishEnvelope(summary) { return JSON.stringify({ think: 'done', finish: { summary: summary || 'done' } }); }

// ---------------------------------------------------------------------------
// F1 — probe.snippet timeoutMs
// ---------------------------------------------------------------------------

describe('F1: probe.snippet timeoutMs', () => {
  function toolsWith(executeDsl) {
    return createProbeTools({ executeDsl });
  }

  it('default path (no timeoutMs) works against a fast executor', async () => {
    const p = toolsWith(() => ({ result: 7 }));
    const r = await p.snippet({ code: 'return 1;' });
    assert.ok(!r.error, 'no error under the default budget');
    assert.match(r.result, /7/);
  });

  it('a small timeoutMs races the executor and names timeoutMs in the error', async () => {
    const p = toolsWith(() => new Promise(() => {})); // never resolves
    const r = await p.snippet({ code: 'return 1;', timeoutMs: 30 });
    assert.ok(r && typeof r.error === 'string', 'timeout produces an error');
    assert.match(r.error, /snippet exceeded 30ms/);
    assert.match(r.error, /timeoutMs/);
    assert.match(r.error, /maxContainers/);
  });

  it('caps timeoutMs at 90000 (100000 → 90000)', async () => {
    const seen = [];
    const p = toolsWith((s) => { seen.push(s); return { result: 1 }; });
    const r = await p.snippet({ code: 'return 1;', timeoutMs: 100000 });
    assert.ok(!r.error, 'fast executor still wins under the capped budget: ' + JSON.stringify(r));
    // Behavioral 90s wait is impractical in tests; the cap is proven by
    // construction — clamp line + cap constant + the error text carrying
    // the cap.
    const SRC = fs.readFileSync(path.join(__dirname, '..', 'lib', 'probe-tools.js'), 'utf8');
    assert.ok(SRC.includes('SNIPPET_MAX_TIMEOUT_MS = 90000'), 'cap constant 90000');
    assert.match(SRC, /Math\.min\(Math\.floor\(a\.timeoutMs\), SNIPPET_MAX_TIMEOUT_MS\)/, 'clamp applied');
    assert.match(SRC, /≤' \+ SNIPPET_MAX_TIMEOUT_MS/, 'timeout error names the cap');
    assert.equal(seen.length, 1);
  });

  it('rejects non-positive/non-numeric timeoutMs without executing', async () => {
    let ran = 0;
    const p = toolsWith(() => { ran++; return { result: 1 }; });
    const bad = await p.snippet({ code: 'return 1;', timeoutMs: -5 });
    assert.match(bad.error, /timeoutMs must be a positive number/);
    const bad2 = await p.snippet({ code: 'return 1;', timeoutMs: 'soon' });
    assert.match(bad2.error, /timeoutMs must be a positive number/);
    assert.equal(ran, 0, 'executor never ran for invalid budgets');
  });

  it('a fast executor result passes through unchanged with timeoutMs set', async () => {
    const p = toolsWith(() => ({ result: { posts: [1, 2] } }));
    const r = await p.snippet({ code: 'return $extractList(".c", {});', timeoutMs: 5000 });
    assert.ok(!r.error);
    assert.match(r.result, /posts/);
  });
});

// ---------------------------------------------------------------------------
// F2 — repeated-identical-failure nudge
// ---------------------------------------------------------------------------

describe('F2: repeated identical failure nudge', () => {

  it('two consecutive identical failing calls push the nudge exactly once', async () => {
    const fail = async () => ({ error: 'SCRIPT_TIMEOUT: something exceeded the budget and kept going past the window end' });
    const events = [];
    const session = createResearchSession({
      requirement: 'collect posts',
      llm: (() => {
        const replies = [
          envelope('probe.snippet', { code: 'return 1;' }),
          envelope('probe.snippet', { code: 'return 1;' }),
          envelope('probe.snippet', { code: 'return 1;' }),
          finishEnvelope('done')
        ];
        let i = 0;
        return async () => reply(replies[i++]);
      })(),
      tools: { 'probe.snippet': fail },
      onEvent: (e) => events.push(e)
    });
    await session.run();
    const st = session.state();
    const notes = (st.session.transcript || []).filter(t => t.kind === 'system' && /REPEATED IDENTICAL FAILURE/.test(t.text || ''));
    assert.equal(notes.length, 1, 'exactly one nudge across 3 identical failures');
    assert.match(notes[0].text, /probe\.snippet/);
    assert.match(notes[0].text, /maxContainers:1/);
  });

  it('a success between failures resets the tracker', async () => {
    const replies = [
      envelope('probe.snippet', { code: 'return 1;' }),
      envelope('probe.snippet', { code: 'return 2;' }),
      envelope('probe.snippet', { code: 'return 2;' }),
      finishEnvelope('done')
    ];
    let i = 0;
    let n = 0;
    const session = createResearchSession({
      requirement: 'collect posts',
      llm: async () => reply(replies[i++]),
      tools: { 'probe.snippet': async (a) => ((n++ % 2 === 1) ? { result: 'ok' } : { error: 'boom happened here' }) },
      onEvent: () => {}
    });
    await session.run();
    const st = session.state();
    const notes = (st.session.transcript || []).filter(t => t.kind === 'system' && /REPEATED IDENTICAL FAILURE/.test(t.text || ''));
    assert.equal(notes.length, 0, 'fail, success, fail → no consecutive pair');
  });

  it('different args → no nudge even when both fail identically', async () => {
    const replies = [
      envelope('probe.snippet', { code: 'return 1;' }),
      envelope('probe.snippet', { code: 'return 2;' }),
      finishEnvelope('done')
    ];
    let i = 0;
    const session = createResearchSession({
      requirement: 'collect posts',
      llm: async () => reply(replies[i++]),
      tools: { 'probe.snippet': async () => ({ error: 'same failure text exactly' }) },
      onEvent: () => {}
    });
    await session.run();
    const st = session.state();
    const notes = (st.session.transcript || []).filter(t => t.kind === 'system' && /REPEATED IDENTICAL FAILURE/.test(t.text || ''));
    assert.equal(notes.length, 0, 'args differ → reset, no nudge');
  });
});

// ---------------------------------------------------------------------------
// F3 — parked-ask tab-title visibility (source audit; wizard.js is UI-side)
// ---------------------------------------------------------------------------

describe('F3: parked-ask tab-title visibility', () => {
  const start = WIZARD_SRC.indexOf('function setSessionBadge(');
  const end = WIZARD_SRC.indexOf('function badgeAfterPanelClose()');
  const body = WIZARD_SRC.slice(start, end);

  it('waiting state sets the question-marker title', () => {
    assert.ok(start !== -1 && end > start, 'setSessionBadge located');
    assert.ok(body.includes("'❓ your answer is needed — ' + BASE_DOC_TITLE"), 'question-marker title');
    // running keeps its own title (split out of the old shared branch)
    assert.ok(body.includes("'● researching… — ' + BASE_DOC_TITLE"), 'running title preserved');
  });

  it('the +5min reminder toast is guarded by panel state', () => {
    assert.match(body, /parkReminderTimer = setTimeout/, 'reminder scheduled on waiting');
    assert.match(body, /if \(sessionPanelOpen\(\)\) showToast/, 'toast only when a panel is still open');
  });

  it('sessionPanelOpen covers the observe panel too', () => {
    const s = WIZARD_SRC.indexOf('function sessionPanelOpen()');
    const e = WIZARD_SRC.indexOf('}', s);
    const seg = WIZARD_SRC.slice(s, e);
    assert.ok(seg.includes('userObservePanel'), 'observe panel included');
  });
});

// ---------------------------------------------------------------------------
// F4 — io.confirm testInput prefill chain (session layer, behavioral)
// ---------------------------------------------------------------------------

describe('F4: io.confirm testInput prefill chain', () => {
  const IN = { type: 'object', properties: { keyword: { type: 'string' }, count: { type: 'integer' } }, required: ['keyword'] };
  const OUT = { type: 'object', required: ['posts'], properties: { posts: { type: 'array', items: { type: 'object' } } } };
  const OUT2 = { type: 'object', required: ['posts'], properties: { posts: { type: 'array', items: { type: 'object' } }, extra: { type: 'string' } } };

  function makeDeps(requestCapture) {
    return {
      rail: {
        pageOpen: async () => ({ tabId: 1, url: 'https://example.com', ready: true }),
        pageState: async () => ({ open: true, tabId: 1, url: 'https://example.com' }),
        executeDsl: async () => ({ result: 1 }),
        ensureLock: async () => {}, releaseLock: async () => {}, dispose: async () => {}, tabId: 1
      },
      runVerify: async () => ({ report: { ok: true }, events: [], raw: {} }),
      getDraftService: () => null,
      applyArtifact: () => {},
      getTestInput: () => ({}), // no artifact → live values empty
      getOutputSchema: () => ({ type: 'object' }),
      getSteps: () => [],
      annotationBridge: null,
      ioConfirmBridge: { request: async (p) => { requestCapture.push(p); return { confirmed: true }; } }
    };
  }

  it('omitted testInput + previously-confirmed session values → proposal carries them', async () => {
    const reqs = [];
    const t = createSessionTools(makeDeps(reqs));
    const ti = { keyword: 'machine learning', count: 10 };
    const r1 = await t.tools['io.confirm']({ inputSchema: IN, outputSchema: OUT, testInput: ti });
    assert.ok(r1.confirmed, 'first confirm lands');
    // Material change (new field) → panel pops again; model OMITS testInput;
    // artifact still does not exist (getTestInput → {}).
    const r2 = await t.tools['io.confirm']({ inputSchema: IN, outputSchema: OUT2, note: 'add extra' });
    assert.ok(r2.confirmed, 'second confirm lands');
    assert.equal(reqs.length, 2, 'panel shown twice');
    assert.deepEqual(reqs[1].testInput, ti, 'session-confirmed values prefilled, never {}');
  });

  it('no values anywhere → {} is kept (parameterless default preserved)', async () => {
    const reqs = [];
    const t = createSessionTools(makeDeps(reqs));
    await t.tools['io.confirm']({ inputSchema: IN, outputSchema: OUT });
    assert.deepEqual(reqs[0].testInput, {});
  });

  it('wizard bridge falls back to wizardState.testInput for an empty proposal (source audit)', () => {
    const at = WIZARD_SRC.indexOf('const rt = (r.testInput && typeof r.testInput');
    assert.ok(at !== -1, 'wizard prefill chain present');
    const seg = WIZARD_SRC.slice(at, WIZARD_SRC.indexOf('const hasValues', at));
    assert.ok(seg.includes('wizardState.testInput'), 'falls back to wizard-level values');
    assert.ok(/Object\.keys\(rt\)\.length > 0/.test(seg), 'non-empty proposal still wins');
  });
});
