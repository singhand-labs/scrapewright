// Seventieth log follow-ups (wallClock death at 31min; 11 varied-args
// probe.snippet SCRIPT_TIMEOUTs the exact-args nudge never saw + the verify
// collect step itself dying at the 120s step budget on an $extractWithHover
// over a 30+-container feed):
// F1 $extractWithHover maxWallMs wall budget + partial envelope + resume
//    cursor (dual-mirror: lib + content-script inline factory);
// F2 repeated-failure nudge error-CLASS keying (same tool + same error
//    class, different args);
// F3 wallClock/maxTurns stop detail names top time sinks (per-tool wall
//    time around dispatchTool + per-tool SCRIPT_TIMEOUT counts).
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const { loadInline } = require('./helpers/inline-ops-factory.js');
const { createResearchSession } = require('../lib/research-session');

const CS_SRC = fs.readFileSync(path.join(__dirname, '..', 'content-script.js'), 'utf8');
const RS_SRC = fs.readFileSync(path.join(__dirname, '..', 'lib', 'research-session.js'), 'utf8');

// ---------------------------------------------------------------------------
// F1 — $extractWithHover maxWallMs (dual-mirror)
// ---------------------------------------------------------------------------

function feedDom(n) {
  const html = Array.from({ length: n }, (_, i) =>
    '<div class="post"><span class="t">t' + i + '</span><a class="a" href="/x' + i + '">a' + i + '</a></div>'
  ).join('');
  const dom = new JSDOM(html, { url: 'https://example.com/feed' });
  global.document = dom.window.document;
  return {
    dom,
    containers: Array.from(dom.window.document.querySelectorAll('.post'))
  };
}

const FIELD_MAP = { title: { selector: '.t' } };
const HOVER_CONFIG = { anchorSel: '.a' };

// slow stub: ~30ms per hover; 1 anchor per container → ~30ms per container.
function slowHover() {
  return async () => {
    const t0 = Date.now();
    while (Date.now() - t0 < 30) { /* busy-wait */ }
    return { hovered: true, htmlSnippet: '<div>card</div>' };
  };
}

function opsFactories() {
  const libOps = require('../lib/list-extract-ops.js');
  return [
    ['lib/list-extract-ops.js', (dom) => libOps],
    ['content-script inline factory', (dom) => loadInline(dom)]
  ];
}

for (const [label, getOps] of opsFactories()) {
  describe('F1: $extractWithHover maxWallMs — ' + label, () => {
    it('budget hit → partial envelope with processed<total and records.length===processed', async () => {
      const { dom, containers } = feedDom(10);
      const out = await getOps(dom).extractWithHoverRecords(
        containers, FIELD_MAP, HOVER_CONFIG, slowHover(), { maxWallMs: 60 });
      // Eighty-eighth log (SECOND occurrence of the crash, 86th v10 + 88th
      // v5 both died as `rs.slice is not a function`): the envelope IS the
      // records array now, with non-enumerable partial/records annotations —
      // array consumers (slice/map) keep working, envelope consumers too.
      assert.ok(Array.isArray(out), 'the budget-hit envelope is the records ARRAY');
      assert.ok(out.partial && out.partial.processed >= 1, 'non-enumerable partial rides the array');
      assert.ok(out.partial.processed < 10, 'budget stopped before the end');
      assert.equal(out.partial.total, 10);
      assert.equal(out.partial.maxWallMs, 60);
      assert.equal(out.length, out.partial.processed);
      assert.equal(out.records, out, 'legacy .records alias resolves to the array itself');
      assert.match(out.partial.note, /wall budget reached/);
      assert.match(out.partial.note, /containerRange:\[\d+,10\]/);
      // processed records are complete: fields + hovercards attached.
      for (const r of out) {
        assert.ok(typeof r.title === 'string');
        assert.equal(r.hovercards.length, 1);
        assert.equal(r.hovercards[0].hovered, true);
      }
      // THE 86th/88th crash shape: array methods on the budget-hit result
      // must not throw.
      assert.equal(out.slice(0, 1).length, 1, 'rs.slice works on the partial result');
      assert.equal(out.map((r) => r.title).length, out.length, 'rs.map works too');
    });

    it('all containers fit → plain records array, no envelope', async () => {
      const { dom, containers } = feedDom(4);
      const out = await getOps(dom).extractWithHoverRecords(
        containers, FIELD_MAP, HOVER_CONFIG, slowHover(), { maxWallMs: 25000 });
      assert.ok(Array.isArray(out), 'all-fit keeps the plain array');
      assert.equal(out.length, 4);
      assert.equal(out[3].hovercards.length, 1);
    });

    it('default budget is 25000ms (no opt → all-fit on a fast stub)', async () => {
      const { dom, containers } = feedDom(3);
      const out = await getOps(dom).extractWithHoverRecords(
        containers, FIELD_MAP, HOVER_CONFIG,
        async () => ({ hovered: true, htmlSnippet: '<div>x</div>' }));
      assert.ok(Array.isArray(out));
      assert.equal(out.length, 3);
    });

    it('resume composes: containerRange-equivalent slice never re-hovers processed containers', async () => {
      const { dom, containers } = feedDom(10);
      let hovers = 0;
      const countingHover = async () => {
        hovers++;
        const t0 = Date.now();
        while (Date.now() - t0 < 30) { /* busy-wait */ }
        return { hovered: true, htmlSnippet: '<div>card</div>' };
      };
      // Pass 1: wall budget cut at K.
      const first = await getOps(dom).extractWithHoverRecords(
        containers, FIELD_MAP, HOVER_CONFIG, countingHover, { maxWallMs: 60 });
      assert.ok(Array.isArray(first) && first.partial, 'array envelope with partial annotation');
      const K = first.partial.processed;
      const hoversAfterFirst = hovers;
      // Pass 2: the resume range [K, N) — exactly what the content-script
      // wrapper's containerRange slicing hands this helper.
      const rest = await getOps(dom).extractWithHoverRecords(
        containers.slice(K), FIELD_MAP, HOVER_CONFIG, countingHover, { maxWallMs: 25000 });
      assert.ok(Array.isArray(rest), 'the remainder fits the budget → plain array');
      assert.equal(rest.length, 10 - K);
      // Only the REMAINING containers were hovered in pass 2.
      assert.equal(hovers - hoversAfterFirst, 10 - K);
      // Union covers every container exactly once.
      assert.equal(first.records.length + rest.length, 10);
    });
  });
}

describe('F1: domExtractWithHover wiring (source audit)', () => {
  it('forwards opts.maxWallMs and unwraps the partial envelope into diagnostics', () => {
    assert.match(CS_SRC, /\{ allowEmpty: true, maxWallMs: opts\.maxWallMs \}/,
      'maxWallMs forwarded to the helper');
    assert.match(CS_SRC, /partialWallBudget = \{\s*processed: partialEnvelope\.partial\.processed/);
    assert.match(CS_SRC, /_diagnostics\.partialNote = partialEnvelope\.partial\.note/);
    assert.match(CS_SRC, /return \{ result: partialEnvelope \|\| records, _diagnostics: _diagnostics \};/,
      'partial runs resolve to the {records, partial} envelope');
  });
});

// ---------------------------------------------------------------------------
// F2 — repeated-failure nudge, error-class keying
// ---------------------------------------------------------------------------

function reply(content) {
  return { content, finish_reason: 'stop', usage: { prompt_tokens: 100, completion_tokens: 10 } };
}
function envelope(tool, args) {
  return JSON.stringify({ think: 't', tool, args: args || {} });
}
function finishEnvelope(summary) { return JSON.stringify({ think: 'done', finish: { summary: summary || 'done' } }); }

async function runSession(toolFn, turns) {
  const events = [];
  const replies = turns.slice();
  replies.push(finishEnvelope('done'));
  const session = createResearchSession({
    requirement: 'collect posts',
    llm: (() => { let i = 0; return async () => reply(replies[i++]); })(),
    tools: { 'probe.snippet': toolFn },
    onEvent: (e) => events.push(e)
  });
  await session.run();
  return session.state().session.transcript.filter(t => t.kind === 'system' && /REPEATED/.test(t.text || ''));
}

describe('F2: repeated failure CLASS nudge', () => {
  it('two different-args SCRIPT_TIMEOUT failures fire the class nudge with timeout teaching', async () => {
    const notes = await runSession(
      async (a) => ({ error: 'SCRIPT_TIMEOUT: script exceeded the 30000ms budget (' + (a.code || '').length + ' chars)' }),
      [
        envelope('probe.snippet', { code: 'return A;' }),
        envelope('probe.snippet', { code: 'return B;' })
      ]);
    const classNotes = notes.filter(n => /REPEATED FAILURE CLASS/.test(n.text));
    assert.equal(classNotes.length, 1, 'exactly one class nudge');
    assert.match(classNotes[0].text, /probe\.snippet failed with SCRIPT_TIMEOUT/);
    assert.match(classNotes[0].text, /the ARGUMENTS are not the problem; the SHAPE is/);
    assert.match(classNotes[0].text, /narrow the batch \(containerRange\/maxContainers\/maxWallMs\)/);
    assert.equal(notes.filter(n => /REPEATED IDENTICAL/.test(n.text)).length, 0,
      'exact-args nudge stays silent when args differ');
  });

  it('two different-args ELEMENT_NOT_FOUND failures fire with NOT_FOUND teaching', async () => {
    const notes = await runSession(
      async (a) => ({ error: 'ELEMENT_NOT_FOUND: no match for ' + JSON.stringify(a).length }),
      [
        envelope('probe.snippet', { code: 'return A;' }),
        envelope('probe.snippet', { code: 'return B;' })
      ]);
    const classNotes = notes.filter(n => /REPEATED FAILURE CLASS/.test(n.text));
    assert.equal(classNotes.length, 1);
    assert.match(classNotes[0].text, /failed with ELEMENT_NOT_FOUND/);
    assert.match(classNotes[0].text, /re-probe the selector against the real DOM/);
  });

  it('a success between failures resets the class tracker', async () => {
    const notes = await runSession(
      async (a) => (a.code === 'return OK;')
        ? { result: 'fine' }
        : { error: 'SCRIPT_TIMEOUT: exceeded the budget ' + a.code.length },
      [
        envelope('probe.snippet', { code: 'return A;' }),
        envelope('probe.snippet', { code: 'return OK;' }),
        envelope('probe.snippet', { code: 'return B;' })
      ]);
    assert.equal(notes.filter(n => /REPEATED FAILURE CLASS/.test(n.text)).length, 0);
  });

  it('identical-args failures keep firing the exact-args nudge (no double nudge)', async () => {
    const notes = await runSession(
      async () => ({ error: 'ELEMENT_NOT_FOUND: nope' }),
      [
        envelope('probe.snippet', { code: 'return 1;' }),
        envelope('probe.snippet', { code: 'return 1;' })
      ]);
    assert.equal(notes.filter(n => /REPEATED IDENTICAL FAILURE/.test(n.text)).length, 1);
    assert.equal(notes.filter(n => /REPEATED FAILURE CLASS/.test(n.text)).length, 0,
      'identical args get the exact-args text only');
  });
});

// ---------------------------------------------------------------------------
// F3 — wallClock stop disclosure: top time sinks
// ---------------------------------------------------------------------------

describe('F3: time-budget stop suffix', () => {
  it('accumulates per-tool ms/calls/timeouts and formats the top-3 suffix', async () => {
    const session = createResearchSession({
      requirement: 'r',
      llm: async () => reply(finishEnvelope()),
      tools: {}
    });
    const t = session.timings;
    assert.ok(t && typeof t.recordToolTiming === 'function', 'timing API exposed');
    t.recordToolTiming('probe.snippet', 812000, true);
    t.recordToolTiming('probe.snippet', 8000, true);
    t.recordToolTiming('verify.run', 96000, false);
    t.recordToolTiming('service.update', 12000, false);
    const entries = t.toolTimingEntries();
    const ps = entries.find(e => e.tool === 'probe.snippet');
    assert.equal(ps.calls, 2);
    assert.equal(ps.timeouts, 2);
    assert.equal(ps.ms, 820000);
    const suffix = t.formatTimeBudgetSuffix();
    assert.match(suffix, /^ \[TIME BUDGET — top consumers: probe\.snippet 820s\/2 calls \(2 timed out\), verify\.run 96s\/1 call, service\.update 12s\/1 call\]$/);
    assert.ok(suffix.length <= 240, 'suffix stays within the 240-char budget');
    assert.equal(entries.length, 3, 'top consumers computed from all entries');
  });

  it('records zero when nothing dispatched → empty suffix', async () => {
    const session = createResearchSession({
      requirement: 'r',
      llm: async () => reply(finishEnvelope()),
      tools: {}
    });
    assert.equal(session.timings.formatTimeBudgetSuffix(), '');
  });

  it('stop paths append the suffix (source audit)', () => {
    assert.match(RS_SRC, /' \+ verifyStopSuffix\(\) \+ formatTimeBudgetSuffix\(\)\)/,
      'maxTurns stop carries the suffix');
    assert.match(RS_SRC, /verifyStopSuffix\(\) \+ formatTimeBudgetSuffix\(\)\);/,
      'wallClock stop carries the suffix');
    assert.match(RS_SRC, /recordToolTiming\(turn\.tool, Date\.now\(\) - __t0/,
      'dispatchTool timed');
  });
});
