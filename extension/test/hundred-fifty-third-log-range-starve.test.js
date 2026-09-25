// extension/test/hundred-fifty-third-log-range-starve.test.js
//
// 153rd log: the session finished best-effort (turn 80, LAST VERIFY FAILED,
// CURRENT ARTIFACT UNVERIFIED) on two stacked harness faults.
//
// A. SPENT-CURSOR THROW. The v4 collect step was a textbook pagination
//    loop:
//      let total = await $count(c);
//      for (let off = 0; all.length < N && off < total + 4; off += 4) {
//        const r = await $extractWithHover(c, fm, { hover: {...}, containerRange: [off, off+4] });
//        if (!r.length) break;
//      }
//    The look-ahead bound (off < total + 4) intentionally probes one batch
//    past the known end so late-mounting containers are picked up; the
//    !r.length break expects an EMPTY ARRAY for a spent cursor. Instead the
//    primitive THREW "no containers matched (after range filtering)": verify
//    tab 283 had 1 container ([4,8] sliced empty), verify tab 285 had 9
//    containers with HEALTHY hovers (hovercardsCaptured 4/4) and threw at
//    [12,16]. Both verifies red on the same shape; the error diagnostics
//    also hardcoded containerMatches: 0 while the SW receipt said 9 —
//    actively steering the model toward a phantom population failure.
//    Fix: a range/index that lies past the last container resolves the
//    empty envelope (exhaustion is data); only a selector matching ZERO
//    containers keeps the throw (a real selector miss).
//
// B. HOVER ENTRY ACTIVATION. While the verify tab held the window
//    (16:21:28 activated:true focusedWindow:true), the model obeyed the
//    red-verify snippet gate and dry-ran hover batches on the RESEARCH tab —
//    which had been hidden since. domHover requests activation only around
//    the TRUSTED_HOVER_REQUEST dispatch, AFTER the pre-dispatch segment
//    (anchor resolution + scrollIntoView + a 50ms settle): on a hidden
//    renderer that settle stretches from 50ms to MINUTES under timer
//    throttling, so the batch starved BEFORE the activation that would have
//    fixed it (SW log: 105s / 498s / 438s pre_dispatch_starved receipts with
//    ZERO tabActivation_request lines on the research tab in that window).
//    The snippets timed out at 60s/90s and the model concluded "hover-based
//    extraction exceeded every execution budget" — a false environmental
//    claim induced by activation-order — then shipped v5 WITHOUT hover
//    (relative postTime, empty comments/shares).
//    Fix: domHover requests activation at ENTRY, before the scroll/settle
//    segment (the dispatch-time wrap stays as a sticky re-assert for a user
//    switching away mid-dwell).
//
// No site tokens.
const { test, describe, it } = require('node:test');
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');

const CS = fs.readFileSync(path.join(__dirname, '..', 'content-script.js'), 'utf8');
const WU = require('../lib/wizard-utils');

function sliceRegion(src, startMarker, endMarker) {
  const start = src.indexOf(startMarker);
  assert.ok(start > -1, startMarker + ' region found');
  const end = src.indexOf(endMarker, start);
  assert.ok(end > start, endMarker + ' landmark after ' + startMarker);
  return src.slice(start, end);
}

// Behavioral harness: run the domExtractWithHover head (entry guards +
// container resolution + range slicing + the processed-empty decision) in a
// vm with the three deps stubbed. The region is cut BEFORE getListExtractOps
// so a spent-cursor return resolves without ever touching the hover runtime.
function loadExtractWithHoverHead(containerCount) {
  const region = sliceRegion(CS, 'async function domExtractWithHover(', 'var ops = getListExtractOps();');
  const ctx = {
    outerDeadlineExceeded: () => null,
    querySelectorAllDeep: () => Array.from({ length: containerCount }, (_, i) => ({ fake: i })),
    notifyBackgroundDiagnostic: () => {},
    sendDebugLog: () => {},
    computeSelectorDifferential: () => null,
    formatSelectorDifferentialNote: () => ''
  };
  vm.createContext(ctx);
  // The region cut ends at a top-level statement of the function body, so a
  // single closing brace completes it for standalone evaluation.
  vm.runInContext(region + '\n}\nthis.__fn = domExtractWithHover;', ctx);
  return ctx.__fn;
}

describe('153rd log A — a spent cursor resolves empty, only a zero-match selector throws', () => {
  it('containerRange past the last container resolves [] with truthful diagnostics (the v4 loop survives)', async () => {
    const fn = loadExtractWithHoverHead(9);
    const out = await fn('[role=feed] > div', { content: { selector: 'x' } }, { hover: { anchorSel: 'a' }, containerRange: [12, 16] });
    assert.deepEqual(out.result, [], 'a range past the end is exhaustion, not an error');
    assert.equal(out._diagnostics.containerMatches, 9, 'diagnostics carry the REAL match count (the old throw hard coded 0 while the SW receipt said 9)');
    assert.equal(out._diagnostics.processedContainers, 0);
    assert.match(out._diagnostics.note, /past the last container/i, 'the note names the spent-cursor shape');
    assert.match(out._diagnostics.note, /pagination|resume/i, 'the note teaches the loop meaning');
  });

  it('containerIndex past the last container resolves [] too (same spent-cursor class)', async () => {
    const fn = loadExtractWithHoverHead(2);
    const out = await fn('[role=feed] > div', { content: { selector: 'x' } }, { hover: { anchorSel: 'a' }, containerIndex: 5 });
    assert.deepEqual(out.result, []);
    assert.equal(out._diagnostics.containerMatches, 2);
  });

  it('a selector matching ZERO containers still THROWS (a real miss keeps its error + differential duty)', async () => {
    const fn = loadExtractWithHoverHead(0);
    await assert.rejects(
      () => fn('[role=feed] > div', { content: { selector: 'x' } }, { hover: { anchorSel: 'a' } }),
      /no containers matched/,
      'zero-match is the wrong-selector class — the 25th-log throw stands'
    );
  });

  it('the spent-cursor branch sits before the throw in source order', () => {
    const region = sliceRegion(CS, 'async function domExtractWithHover(', 'var ops = getListExtractOps();');
    const spent = region.indexOf('containers.length > 0');
    const thrw = region.indexOf('throw _noContainersErr');
    assert.ok(spent > -1 && thrw > spent, 'spent-cursor branch precedes the throw');
  });
});

describe('153rd log B — domHover activates at ENTRY, before the starvable segment', () => {
  it('the entry activation precedes the scrollIntoView settle (source order)', () => {
    const region = sliceRegion(CS, 'async function domHover(', 'async function domExtractWithHover(');
    const entryAct = region.indexOf("withTabActivation('hoverEntry'");
    const scroll = region.indexOf('anchor.scrollIntoView(');
    assert.ok(entryAct > -1, 'the entry activation wrap exists (own label so SW logs distinguish entry activation from dispatch re-assert)');
    assert.ok(scroll > -1, 'the scrollIntoView segment exists');
    assert.ok(entryAct < scroll, 'activation is requested BEFORE the pre-dispatch segment (the 153rd zombies starved with zero activation attempts)');
  });

  it('the dispatch-time wrap is retained as a sticky re-assert', () => {
    const region = sliceRegion(CS, 'async function domHover(', 'async function domExtractWithHover(');
    const dispatchAct = region.indexOf("withTabActivation('hover',");
    assert.ok(dispatchAct > -1, 'the dispatch wrap stays — a user switching away mid-dwell still gets re-asserted activation');
    const dispatchIdx = region.indexOf("type: 'TRUSTED_HOVER_REQUEST'");
    assert.ok(dispatchIdx > dispatchAct, 'the dispatch wrap surrounds the trusted dispatch');
  });
});

describe('153rd log C — the DSL guide teaches the spent-cursor semantics', () => {
  it('the containerRange bullet says a past-the-end range resolves [] and only zero-match throws', () => {
    assert.match(WU.SCRIPT_DSL_GUIDE, /past the[\s\S]{0,20}last container[\s\S]{0,220}resolves to \[\]/i);
    assert.match(WU.SCRIPT_DSL_GUIDE, /matching ZERO containers[\s\S]{0,120}throw/i);
  });
});
