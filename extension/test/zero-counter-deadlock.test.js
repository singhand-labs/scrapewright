// Regression for console.log 2026-08-31 16:06-16:15 (fourth session): after
// a user-feedback autoFix rewrote the scroll counter to count only cards
// containing a permalink href, the permalink regex matched 0 hrefs on every
// card — uniqueCount stayed 0 for 33 consecutive not-ready iterations while
// the user watched the page fill with posts (~9.5 min, aborted manually).
// Root causes pinned here:
//   1. The exhausted exit was guarded by '&& uniqueCount > 0' — a pattern the
//      DSL guide's own example taught — making exhaustion unreachable at
//      count 0 (ZERO-TRAP deadlock).
//   2. Selector diagnostics saw nothing wrong (containers matched; the
//      SCRIPT-LEVEL JS filter zeroed the count), so no detector fired.
//   3. attr-based fields produced NO sample values in diagnostics, so neither
//      autoFix nor the log could see the actual href shapes the regex should
//      have matched.
// These tests pin: parseCounterFields/isFrozenZeroNotReady/detectFrozenZeroCounter,
// the deadlock-free DSL examples, the ZERO-TRAP COUNTER rule, the wizard
// circuit-breaker + failure-path relabel wiring, and sampleValues diagnostics.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const {
  detectFrozenZeroCounter,
  parseCounterFields,
  isFrozenZeroNotReady,
  FROZEN_ZERO_STREAK_THRESHOLD
} = require('../lib/wizard-utils');

const WIZARD_UTILS_SRC = fs.readFileSync(path.join(__dirname, '..', 'lib', 'wizard-utils.js'), 'utf8');
const RUNNER_SRC = fs.readFileSync(path.join(__dirname, '..', 'lib', 'verify-runner.js'), 'utf8');
const CONTENT_SCRIPT_SRC = fs.readFileSync(path.join(__dirname, '..', 'content-script.js'), 'utf8');
const LIST_OPS_SRC = fs.readFileSync(path.join(__dirname, '..', 'lib', 'list-extract-ops.js'), 'utf8');

function itEvt(stepId, iteration, preview, diags) {
  return {
    type: 'STEP_ITERATION',
    stepId,
    iteration,
    maxIterations: 40,
    domActivity: [],
    resultPreview: preview,
    selectorDiagnostics: diags || []
  };
}

// The exact preview shape from the fourth-session log (32 logged iterations,
// uniqueCount 0 on every one, noGrowth climbing without ever resetting).
const frozenPreview = (noGrowth) =>
  '{"done":false,"uniqueCount":0,"noGrowth":' + noGrowth + ',"seenSignatures":[]}';
// Containers matched fine (extractListMulti saw N articles) — the JS regex
// filter inside the script zeroed the count. This is the discriminator
// against COUNT_SELECTOR_BLIND (selectors themselves matching 0).
const containersMatchedDiag = (n) => ({
  api: 'extractListMulti', containerSelector: 'div[role="article"]',
  containerMatches: n, perField: []
});

describe('parseCounterFields', () => {
  it('classifies uniqueCount/postCount-style names ending in "count"', () => {
    const c = parseCounterFields('{"done":false,"uniqueCount":0,"postCount":0}');
    assert.deepEqual(c.zero.sort(), ['postCount', 'uniqueCount']);
    assert.equal(c.positive.length, 0);
  });

  it('treats bare aggregate names (total/matched/found/loaded) as counters', () => {
    const c = parseCounterFields('{"done":false,"total":0,"matched":5}');
    assert.deepEqual(c.zero, ['total']);
    assert.deepEqual(c.positive, ['matched']);
  });

  it('EXCLUDES control fields — noGrowth/stalled/iteration are not counters', () => {
    const c = parseCounterFields('{"done":false,"noGrowth":12,"stalled":3,"iteration":7}');
    assert.equal(c.zero.length, 0, 'noGrowth/stalled/iteration must not be counters: ' + JSON.stringify(c));
    assert.equal(c.positive.length, 0);
  });

  it('handles null/empty previews', () => {
    assert.equal(parseCounterFields(null).zero.length, 0);
    assert.equal(parseCounterFields('').positive.length, 0);
  });
});

describe('isFrozenZeroNotReady', () => {
  it('true for done:false with only-zero counters (the log preview)', () => {
    assert.equal(isFrozenZeroNotReady(frozenPreview(7)), true);
  });

  it('false when any counter is positive (content arrived)', () => {
    assert.equal(isFrozenZeroNotReady('{"done":false,"uniqueCount":4,"noGrowth":0}'), false);
  });

  it('false for done:true (EMPTY_EXTRACTION domain, not a trap)', () => {
    assert.equal(isFrozenZeroNotReady('{"done":true,"uniqueCount":0,"exhausted":true}'), false);
  });

  it('false when no counter fields exist (no evidence)', () => {
    assert.equal(isFrozenZeroNotReady('{"done":false,"clicked":2}'), false);
  });
});

describe('detectFrozenZeroCounter', () => {
  it('fires on the fourth-session signature: >= threshold frozen iterations, never positive', () => {
    const events = [];
    for (let i = 1; i <= 20; i++) {
      events.push(itEvt('2', i, frozenPreview(i), [containersMatchedDiag(6)]));
    }
    const r = detectFrozenZeroCounter(events);
    assert.ok(r, 'should fire');
    assert.equal(r.stepId, '2');
    assert.equal(r.frozenIterations, 20);
    assert.ok(r.counterFields.includes('uniqueCount'));
    assert.equal(r.selectorMatchedSomething, true,
      'containers matching while counters stay 0 is the script-filter proof');
  });

  it('silent below the streak threshold (slow loads recover legitimately)', () => {
    const events = [];
    for (let i = 1; i < FROZEN_ZERO_STREAK_THRESHOLD; i++) {
      events.push(itEvt('2', i, frozenPreview(i), [containersMatchedDiag(6)]));
    }
    assert.equal(detectFrozenZeroCounter(events), null);
  });

  it('silent when any iteration ever had a positive counter (recovered)', () => {
    const events = [];
    for (let i = 1; i <= 10; i++) {
      events.push(itEvt('2', i, frozenPreview(i), [containersMatchedDiag(6)]));
    }
    events.push(itEvt('2', 11, '{"done":false,"uniqueCount":3,"noGrowth":0}', [containersMatchedDiag(6)]));
    for (let i = 12; i <= 20; i++) {
      events.push(itEvt('2', i, '{"done":false,"uniqueCount":3,"noGrowth":' + (i - 11) + '}', [containersMatchedDiag(6)]));
    }
    assert.equal(detectFrozenZeroCounter(events), null);
  });

  it('selectorMatchedSomething=false when diagnostics also matched 0 (COUNT_SELECTOR_BLIND class)', () => {
    const events = [];
    for (let i = 1; i <= 10; i++) {
      events.push(itEvt('2', i, frozenPreview(i), [containersMatchedDiag(0)]));
    }
    const r = detectFrozenZeroCounter(events);
    assert.ok(r, 'still fires — the frozen result is evidence on its own');
    assert.equal(r.selectorMatchedSomething, false);
  });

  it('ignores iterations without counter fields and tolerates non-array input', () => {
    const events = [];
    for (let i = 1; i <= 12; i++) {
      events.push(itEvt('3', i, '{"done":false,"clicked":0,"errors":0}'));
    }
    assert.equal(detectFrozenZeroCounter(events), null);
    assert.equal(detectFrozenZeroCounter(null), null);
    assert.equal(detectFrozenZeroCounter('nope'), null);
  });

  it('does not judge OTHER steps frozen when a different step is healthy', () => {
    const events = [];
    for (let i = 1; i <= 12; i++) {
      events.push(itEvt('2', i, frozenPreview(i), [containersMatchedDiag(6)]));
      events.push(itEvt('4', i, '{"done":false,"uniqueCount":' + i + '}'));
    }
    const r = detectFrozenZeroCounter(events);
    assert.ok(r);
    assert.equal(r.stepId, '2');
  });
});

describe('DSL guide: zero-counter deadlock removed from taught examples', () => {
  it('canonical noGrowth exit no longer guards on uniqueCount > 0', () => {
    // The DEADLOCK WARNING comment legitimately NAMES the wrong form; the
    // audit matches the executable if-statement shape only.
    assert.ok(!/if\s*\(\s*noGrowth\s*>=\s*3\s*&&\s*uniqueCount\s*>\s*0/.test(WIZARD_UTILS_SRC),
      'the deadlock-guarded example must be gone');
    assert.ok(/if\s*\(noGrowth\s*>=\s*3\)\s*return\s*\{\s*done:\s*true/.test(WIZARD_UTILS_SRC),
      'the deadlock-free exit must be taught in its place');
  });

  it('stricter-variant stalled exit no longer guards on postCount > 0', () => {
    assert.ok(!/stalled\s*>=\s*3\s*&&\s*postCount\s*>\s*0/.test(WIZARD_UTILS_SRC),
      'the stalled example must not teach the unreachable guard');
    assert.ok(/if\s*\(stalled\s*>=\s*3\)\s*return\s*\{\s*done:\s*true/.test(WIZARD_UTILS_SRC));
  });

  it('the canonical example carries the DEADLOCK WARNING explanation', () => {
    assert.ok(/DEADLOCK WARNING/.test(WIZARD_UTILS_SRC));
    assert.ok(/stays 0 on every iteration/.test(WIZARD_UTILS_SRC));
  });

  it('ZERO-TRAP COUNTER rule exists with the three defenses', () => {
    assert.ok(/ZERO-TRAP COUNTER/.test(WIZARD_UTILS_SRC));
    assert.ok(/sample before you filter/.test(WIZARD_UTILS_SRC));
    assert.ok(/RAW fallback counter/.test(WIZARD_UTILS_SRC));
    assert.ok(/never guard the exhausted exit/.test(WIZARD_UTILS_SRC));
    // Permalink shape list — teach variance, not one assumed shape.
    assert.ok(/share\/p\//.test(WIZARD_UTILS_SRC));
    assert.ok(/story\.php/.test(WIZARD_UTILS_SRC));
    assert.ok(/watch\?v=/.test(WIZARD_UTILS_SRC));
    // Cross-reference to the card-type rule.
    assert.match(WIZARD_UTILS_SRC, /ZERO-TRAP COUNTER[\s\S]*?CARD-TYPE HETEROGENEITY|CARD-TYPE HETEROGENEITY[\s\S]*?ZERO-TRAP COUNTER/);
  });

  it('CARD-TYPE HETEROGENEITY teaches counter consistency (corollary c)', () => {
    const idx = WIZARD_UTILS_SRC.indexOf('CARD-TYPE HETEROGENEITY');
    const chunk = WIZARD_UTILS_SRC.slice(idx, idx + 4000);
    assert.ok(/scroll step's counter is a card filter too/.test(chunk),
      'the scroll-counter corollary must live inside the CARD-TYPE rule');
  });
});

describe('verify-runner wiring: circuit breaker + failure-path relabel (was wizard.js testScript)', () => {
  const runnerSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'verify-runner.js'), 'utf8');
  it('the run loop tracks frozen streaks and aborts via the internal abort flag', () => {
    assert.ok(/zeroCounterStreaks/.test(runnerSrc), 'streak map tracked');
    assert.ok(/zeroCounterBreaker/.test(runnerSrc), 'breaker state recorded');
    assert.ok(/internalAbort\.aborted = true/.test(runnerSrc), 'breaker aborts the run');
    // The breaker must reuse the shared parsing helpers, not re-implement.
    assert.ok(/parseCounterFields\(evt\.resultPreview\)/.test(runnerSrc));
    assert.ok(/isFrozenZeroNotReady\(evt\.resultPreview\)/.test(runnerSrc));
    assert.ok(/FROZEN_ZERO_STREAK_THRESHOLD/.test(runnerSrc));
  });

  it('breaker state is created fresh per runner (per run)', () => {
    assert.ok(/const zeroCounterStreaks = new Map\(\)/.test(runnerSrc));
    assert.ok(/let zeroCounterBreaker = null/.test(runnerSrc));
  });

  it('failure path relabels the breaker abort as ZERO_COUNTER_FROZEN', () => {
    const i = runnerSrc.indexOf('ZERO_COUNTER_FROZEN: step');
    assert.ok(i > 0, 'relabel message exists');
    // The relabel is keyed off the breaker abort (TEST_ABORTED), not other errors.
    const cond = runnerSrc.slice(0, i).lastIndexOf('zeroCounterBreaker &&');
    assert.ok(cond > 0 && runnerSrc.slice(cond, cond + 100).includes('TEST_ABORTED'),
      'relabel fires only when the breaker aborted the run');
    const chunk = runnerSrc.slice(i, i + 2500);
    assert.ok(/count > 0/.test(chunk), 'names the guard to remove');
    assert.ok(/RAW fallback counter/.test(chunk), 'teaches the fallback counter');
  });

  it('POLL_EXHAUSTED augmentation also runs the post-hoc detector', () => {
    const i = runnerSrc.indexOf('POLL_EXHAUSTED — root cause: COUNT_SELECTOR_BLIND');
    const chunk = runnerSrc.slice(i, i + 6000);
    assert.ok(/detectFrozenZeroCounter/.test(chunk),
      'post-hoc frozen-zero detection rides the POLL_EXHAUSTED branch');
    assert.ok(/POLL_EXHAUSTED — root cause: ZERO_COUNTER_FROZEN/.test(chunk));
  });

  it('knowledge-units carry the zero-trap-counter rule (session LLM surface)', () => {
    const kuSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'knowledge-units.js'), 'utf8');
    const i = kuSrc.indexOf("id: 'zero-trap-counter'");
    assert.ok(i !== -1, 'zero-trap-counter unit missing');
    const body = kuSrc.slice(i, kuSrc.indexOf('id:', i + 10));
    assert.ok(/frozen counter/i.test(body), 'frozen-counter defense missing');
    assert.ok(/never keep scrolling/.test(body), 'never-keep-scrolling defense missing');
  });
});

describe('computeExtractListDiagnostics sampleValues (attr fields were sample-blind)', () => {
  const html = `
    <div id="feed">
      <div class="card" id="c1">
        <a href="https://example.com/share/p/Ab12/">post 1</a>
        <a href="https://example.com/somepage">profile</a>
      </div>
      <div class="card" id="c2">
        <a href="https://example.com/share/p/Cd34/">post 2</a>
      </div>
    </div>`;
  const dom = new JSDOM('<!DOCTYPE html><body>' + html + '</body>');
  const doc = dom.window.document;
  const containers = Array.from(doc.querySelectorAll('.card'));

  const ops = require('../lib/list-extract-ops');

  it('single mode: attr field now yields sampleValues (previously nothing)', () => {
    const d = ops.computeExtractListDiagnostics(
      containers, { h: { selector: 'a[href]', attr: 'href' } }, '.card');
    const f = d.perField.find(x => x.field === 'h');
    assert.equal(f.matchCount, 2);
    assert.ok(f.sampleValues.length >= 1, 'attr field must produce sampleValues');
    assert.ok(f.sampleValues.some(v => v.includes('/share/p/')),
      'observed href shapes must be visible: ' + JSON.stringify(f.sampleValues));
  });

  it('multi mode: samples EVERY match of the FIRST container (not just the first match)', () => {
    const d = ops.computeExtractListDiagnostics(
      containers, { h: { selector: 'a[href]', attr: 'href' } }, '.card', true);
    const f = d.perField.find(x => x.field === 'h');
    // c1 has TWO anchors — both shapes must appear, else a permalink regex
    // written against first-match samples misses the real post link.
    assert.ok(f.sampleValues.some(v => v.includes('/share/p/Ab12/')), 'post link sampled');
    assert.ok(f.sampleValues.some(v => v.includes('/somepage')), 'other link sampled too');
    assert.equal(f.matchCount, 2, 'matchCount still counts containers with >=1 match');
  });

  it('multi mode matchCount counts containers, value list capped at 5', () => {
    const many = new JSDOM('<!DOCTYPE html><body><div class="card">' +
      Array.from({ length: 8 }, (_, i) => '<a href="/x/' + i + '">a' + i + '</a>').join('') +
      '</div></body></body>'.replace('</body></body>', '') + '</body>');
    const c = many.window.document.querySelectorAll('.card');
    const d = ops.computeExtractListDiagnostics(
      Array.from(c), { h: { selector: 'a[href]', attr: 'href' } }, '.card', true);
    const f = d.perField.find(x => x.field === 'h');
    assert.equal(f.sampleValues.length, 5, 'cap at 5 values');
    assert.equal(f.matchCount, 1, 'one container with >=1 match');
  });

  it('textContent fields keep sampleValues alongside legacy sampleTexts', () => {
    const d = ops.computeExtractListDiagnostics(
      containers, { t: 'a' }, '.card');
    const f = d.perField.find(x => x.field === 't');
    assert.ok(f.sampleValues.length > 0);
    assert.ok(f.sampleTexts.length > 0, 'legacy fields unchanged for back-compat');
  });
});

describe('content-script wiring for sampleValues + SW mirror', () => {
  it('domExtractListMulti requests multiMode diagnostics and relabels the api', () => {
    assert.ok(/computeExtractListDiagnostics\(containers, fieldMap, containerSel, true\)/.test(CONTENT_SCRIPT_SRC),
      'multi variant must pass multiMode=true');
    assert.ok(/_diagnostics\.api = 'extractListMulti'/.test(CONTENT_SCRIPT_SRC));
  });

  it('entry diagnostics mirrored to the background SW log (page console is invisible to log capture)', () => {
    assert.ok(/notifyBackgroundDiagnostic\('extractListMulti_entry'/.test(CONTENT_SCRIPT_SRC));
    assert.ok(/notifyBackgroundDiagnostic\('extractList_entry'/.test(CONTENT_SCRIPT_SRC));
  });

  it('inline fallback mirrors the lib sampleValues semantics (drift)', () => {
    assert.ok(/const sampleValues = \[\]/.test(CONTENT_SCRIPT_SRC));
    assert.ok(/pushValue/.test(CONTENT_SCRIPT_SRC));
    // Inline copy must accept the 4th param like the lib.
    assert.ok(/function computeExtractListDiagnostics\(containers, fieldMap, containerSelector, multiMode\)/.test(CONTENT_SCRIPT_SRC));
  });
});

describe('summarizeAllStepDiagnostics renders observed values', () => {
  const { summarizeAllStepDiagnostics } = require('../lib/wizard-utils');

  it('per-field observed values appear in the summary (the ZERO-TRAP evidence channel)', () => {
    const evt = {
      type: 'STEP_ITERATION', stepId: '2', stepName: 'scroll_and_load',
      iteration: 1,
      resultPreview: '{"done":false,"uniqueCount":0}',
      selectorDiagnostics: [{
        api: 'extractListMulti',
        containerSelector: 'div[role="article"]',
        containerMatches: 6,
        firstContainerHtml: null,
        perField: [{
          field: 'h', subSelector: 'a[href]', attr: 'href', matchCount: 6,
          sampleTexts: [], sampleHrefs: [],
          sampleValues: ['https://example.com/share/p/Ab12/', 'https://example.com/somepage']
        }]
      }]
    };
    const out = summarizeAllStepDiagnostics([evt], [{ id: '2', name: 'scroll_and_load' }]);
    assert.match(out, /\$extractListMulti/, 'multi api rendered with its own name');
    assert.match(out, /observed values for 'h'/, 'values line present');
    assert.match(out, /share\/p\/Ab12/, 'actual href shape visible');
  });
});

describe('universality: zero-trap additions carry no site tokens', () => {
  const FORBIDDEN = /facebook|twitter|linkedin|tiktok|reddit|\bfb\b/i;
  it('wizard-utils.js guide + detector text', () => {
    assert.ok(!FORBIDDEN.test(WIZARD_UTILS_SRC), 'no site tokens in wizard-utils.js');
  });
  it('new verify-runner relabel messages', () => {
    const i = RUNNER_SRC.indexOf('ZERO_COUNTER_FROZEN');
    const chunk = RUNNER_SRC.slice(i, i + 3000);
    assert.ok(!FORBIDDEN.test(chunk), 'no site tokens in the relabel message');
  });
});
