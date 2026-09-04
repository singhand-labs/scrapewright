// Twenty-third log F2: $count matches regardless of visibility (querySelectorAllDeep)
// while $exists is visibility-gated (isElementVisible) — the divergence
// (probe.count → 5, script $exists → false) is exactly the hidden-but-readable
// trap that shipped postedTime/location as "" in 5/5 records. The count census
// diagnostics carry the visible/invisible split, and probe.count surfaces it.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const { computeSimpleSelectorDiagnostics } = require('../lib/list-extract-ops');
const { createProbeTools } = require('../lib/probe-tools');

function domWithMatches() {
  const dom = new JSDOM(
    '<div class="m" id="v1">a</div>' +
    '<div class="m" id="v2">b</div>' +
    '<div class="m" style="display:none">c</div>' +
    '<div class="m" style="visibility:hidden">d</div>'
  );
  const doc = dom.window.document;
  // jsdom rects are zero-size for everything — give the two intended-visible
  // matches a real rect so only style-hidden ones count as invisible.
  for (const id of ['v1', 'v2']) {
    doc.getElementById(id).getBoundingClientRect = () => ({ width: 100, height: 10, top: 0, left: 0 });
  }
  return doc;
}

describe('F2a: count diagnostics carry the visible/invisible split', () => {
  it('count api reports visibleCount/invisibleCount; list/extract apis stay unchanged shape', () => {
    const doc = domWithMatches();
    const els = Array.from(doc.querySelectorAll('.m'));
    const cd = computeSimpleSelectorDiagnostics(els, '.m', 'count');
    assert.equal(cd.api, 'count');
    assert.equal(cd.matchCount, 4);
    assert.equal(cd.visibleCount, 2);
    assert.equal(cd.invisibleCount, 2);

    const ld = computeSimpleSelectorDiagnostics(els, '.m', 'list');
    assert.equal(ld.matchCount, 4);
    assert.equal('visibleCount' in ld, false, 'visibility census only for count (perf/context diet)');
  });

  it('all-visible and empty populations are reported without the trap note fields being wrong', () => {
    const dom = new JSDOM('<div class="x">only</div>');
    const doc = dom.window.document;
    doc.querySelector('.x').getBoundingClientRect = () => ({ width: 50, height: 5, top: 0, left: 0 });
    const cd = computeSimpleSelectorDiagnostics(Array.from(doc.querySelectorAll('.x')), '.x', 'count');
    assert.equal(cd.visibleCount, 1);
    assert.equal(cd.invisibleCount, 0);
    const none = computeSimpleSelectorDiagnostics([], '.x', 'count');
    assert.equal(none.matchCount, 0);
    assert.equal(none.visibleCount, 0);
    assert.equal(none.invisibleCount, 0);
  });
});

describe('F2a-mirror: content-script inline copy computes the same split', () => {
  it('inline computeSimpleSelectorDiagnostics mirrors the visibility census (drift parity)', () => {
    const SRC = fs.readFileSync(path.join(__dirname, '..', 'content-script.js'), 'utf8');
    const start = SRC.indexOf('function computeSimpleSelectorDiagnostics');
    assert.ok(start !== -1);
    let i = SRC.indexOf('{', start), depth = 0, end = -1;
    for (; i < SRC.length; i++) {
      if (SRC[i] === '{') depth += 1;
      else if (SRC[i] === '}') { depth -= 1; if (depth === 0) { end = i + 1; break; } }
    }
    const inlineFn = eval('(function (isVisibleForDiagnostics) { return (' + SRC.slice(start, end) + '); })')(
      require('../lib/list-extract-ops').isVisibleForDiagnostics
    );
    const doc = domWithMatches();
    const els = Array.from(doc.querySelectorAll('.m'));
    const cd = inlineFn(els, '.m', 'count');
    assert.equal(cd.matchCount, 4);
    assert.equal(cd.visibleCount, 2);
    assert.equal(cd.invisibleCount, 2);
  });
});

describe('F2b: probe.count surfaces the split from the executor envelope', () => {
  it('envelope-executor rail: count returns visible/invisible counts + reconciliation note when invisible > 0', async () => {
    const countDiag = { api: 'count', selector: '.m', matchCount: 4, visibleCount: 2, invisibleCount: 2 };
    const probes = createProbeTools({
      executeDsl: async (snippet) => {
        assert.match(snippet, /\$count\(['"]\.m['"]\)/);
        return { result: 4, selectorDiagnostics: [countDiag] };
      }
    });
    const out = await probes.count('.m');
    assert.equal(out.count, 4);
    assert.equal(out.visibleCount, 2);
    assert.equal(out.invisibleCount, 2);
    assert.match(out.note, /visibility-gated/);
  });

  it('all-visible counts stay lean (no split fields, no note)', async () => {
    const probes = createProbeTools({
      executeDsl: async () => ({ result: 3, selectorDiagnostics: [{ api: 'count', selector: '.x', matchCount: 3, visibleCount: 3, invisibleCount: 0 }] })
    });
    const out = await probes.count('.x');
    assert.deepEqual(out, { count: 3 });
  });

  it('legacy value-only executors (raw number return) keep working', async () => {
    const probes = createProbeTools({ executeDsl: async () => 7 });
    const out = await probes.count('.x');
    assert.deepEqual(out, { count: 7 });
  });

  it('a snippet whose own result IS an object with selectorDiagnostics-shaped keys is not mis-unwrapped', async () => {
    // The envelope unwrap must key on BOTH result and Array selectorDiagnostics;
    // a plain object result with a coincidental key must pass through as the value.
    const probes = createProbeTools({ executeDsl: async () => ({ selectorDiagnostics: ['not-an-envelope'], count: 5 }) });
    const out = await probes.count('.x');
    // Not an envelope (no `result` key) — the whole object IS the snippet value;
    // count coerces the non-number to 0 exactly like the old behavior.
    assert.deepEqual(out, { count: 0 });
  });
});
