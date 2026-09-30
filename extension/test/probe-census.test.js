// Speed track (user directive 2026-09-29): probe.census — the page-level
// field census. One call replaces the per-field serial loop (2-3 turns per
// field, 20-30 turns per fieldMap). These tests pin: lane classification
// with cross-sample coverage, the aria-carrier lane, the href-token identity
// diff, even sampling, the opt-in hover phase, error paths, and the steering
// wiring (spec entry, methodology routing, receipt budget, universality).

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const __dom = new JSDOM('<!DOCTYPE html><html><body></body></html>');
global.DOMParser = __dom.window.DOMParser;
global.NodeFilter = __dom.window.NodeFilter;
global.Node = __dom.window.Node;

const { createProbeTools } = require('../lib/probe-tools');
const { createObservationLog } = require('../lib/observation-log');

function cardHtml(n, opts) {
  const o = opts || {};
  return '<div class="card">' +
    '<a class="ttl" href="/post/' + n + '?story=' + (1000 + n) + '">Title ' + n + '</a>' +
    '<span class="ts">' + (o.ts || (n + ' days ago')) + '</span>' +
    '<span class="cnt">' + (o.cnt || (10 * n)) + '</span>' +
    '<span class="tip" aria-labelledby="tt' + n + '">' + (o.ts || (n + ' days ago')) + '</span>' +
    '<span class="pid" data-id="p' + n + '"></span>' +
    '</div>';
}

function makeCensusTools(records, opts) {
  const o = opts || {};
  const observationLog = createObservationLog();
  const calls = [];
  const tools = createProbeTools({
    executeDsl: async (snippet) => {
      calls.push(snippet);
      if (/\$extractWithHover\(/.test(snippet)) {
        // The 62nd-log deterministic capability-gate failure: Enhanced
        // Mode off means the trusted hover NEVER dispatches — an error
        // object, not an empty harvest.
        if (o.hoverError) return { error: 'HOVER_SKIPPED_ENHANCED_MODE: trusted hover dispatch is unavailable (Enhanced Mode off) — use the still-working labelledby/attr/text routes' };
        return [{
          __t_label: '',
          __t_aria: '',
          __t_text: 'September 11, 2026',
          hovercards: []
        }];
      }
      // Pre-wrapped record objects pass through (empty/unparseable-sample
      // tests need control over the __c_html payload itself).
      return records.map((h) => (h && typeof h === 'object' && !Array.isArray(h)) ? h : { __c_html: h });
    },
    observationLog
  });
  return { tools, observationLog, calls };
}

describe('probe.census', () => {
  it('classifies lanes with cross-sample coverage and distinct sample texts', async () => {
    const records = [cardHtml(1), cardHtml(2), cardHtml(3)];
    const { tools } = makeCensusTools(records);
    const r = await tools.census({ containerSel: 'div.card' });
    assert.equal(r.total, 3);
    assert.deepEqual(r.sampled, [0, 1, 2]);
    assert.ok(r.lanes.time && r.lanes.time.length, 'time lane present');
    const ts = r.lanes.time.find((c) => c.selector === 'span.ts');
    assert.ok(ts, 'span.ts in the time lane');
    assert.equal(ts.coverage, '3/3');
    assert.ok(ts.texts.length >= 2, 'distinct sample texts carried');
    assert.ok(r.lanes.count && r.lanes.count.some((c) => c.selector === 'span.cnt' && c.coverage === '3/3'), 'count lane');
    assert.ok(r.lanes.url && r.lanes.url.some((c) => c.selector === 'a.ttl' && c.coverage === '3/3'), 'url lane');
    assert.ok(r.note && /coverage/i.test(r.note), 'teaching note present');
  });

  it('reports the aria-carrier lane (hidden-value carriers)', async () => {
    const { tools } = makeCensusTools([cardHtml(1), cardHtml(2), cardHtml(3)]);
    const r = await tools.census({ containerSel: 'div.card' });
    assert.ok(r.lanes.aria && r.lanes.aria.length, 'aria lane present');
    const carrier = r.lanes.aria.find((c) => /aria-labelledby/.test(c.selector));
    assert.ok(carrier, 'labelledby carrier selector');
    assert.equal(carrier.refAttr, 'aria-labelledby');
    assert.equal(carrier.coverage, '3/3');
  });

  it('diffs href tokens into per-record identity candidates', async () => {
    const { tools } = makeCensusTools([cardHtml(1), cardHtml(2), cardHtml(3)]);
    const r = await tools.census({ containerSel: 'div.card' });
    assert.ok(Array.isArray(r.hrefIdentity) && r.hrefIdentity.length, 'hrefIdentity present');
    const q = r.hrefIdentity.find((e) => e.token === 'query:story');
    assert.ok(q, 'query:story token diffed');
    assert.equal(q.coverage, '3/3');
    assert.deepEqual(q.samples, ['1001', '1002', '1003']);
  });

  it('samples evenly across the population (first/middle/last)', async () => {
    const records = [];
    for (let i = 0; i < 7; i++) records.push(cardHtml(i + 1));
    const { tools } = makeCensusTools(records);
    const r = await tools.census({ containerSel: 'div.card' });
    assert.deepEqual(r.sampled, [0, 3, 6]);
  });

  it('hover:true folds the one-card timestamp dance into timeHover', async () => {
    const { tools, calls } = makeCensusTools([cardHtml(1), cardHtml(2)]);
    const r = await tools.census({ containerSel: 'div.card', hover: true });
    assert.ok(r.timeHover && typeof r.timeHover === 'object', 'timeHover embedded');
    assert.equal(r.timeHover.absolute, 'September 11, 2026');
    assert.ok(calls.some((s) => /\$extractWithHover\(/.test(s)), 'hover snippet dispatched');
  });

  it('zero matches returns an honest empty census, not an error', async () => {
    const { tools } = makeCensusTools([]);
    const r = await tools.census({ containerSel: 'div.nope' });
    assert.equal(r.total, 0);
    assert.ok(r.note && /0 containers/.test(r.note));
  });

  it('missing containerSel returns a teaching error', async () => {
    const { tools } = makeCensusTools([cardHtml(1)]);
    const r = await tools.census({});
    assert.ok(r.error && /containerSel/.test(r.error));
  });

  it('records exactly one observation receipt on success', async () => {
    const { tools, observationLog } = makeCensusTools([cardHtml(1), cardHtml(2)]);
    await tools.census({ containerSel: 'div.card' });
    assert.equal(observationLog.size(), 1);
    assert.ok(observationLog.covers('div.card'));
    const entry = observationLog.serialize().entries[0];
    assert.equal(entry.tool, 'probe.census');
    assert.match(entry.summary, /lanes=/);
  });
});

describe('probe.census failure quarantine + sampling edges', () => {
  it('a hover-phase error (HOVER_SKIPPED_ENHANCED_MODE) still returns lanes with timeHover.error disclosed, no throw', async () => {
    const { tools } = makeCensusTools([cardHtml(1), cardHtml(2), cardHtml(3)], { hoverError: true });
    const r = await tools.census({ containerSel: 'div.card', hover: true });
    assert.ok(r.lanes && r.lanes.time && r.lanes.time.length, 'lanes computed before the hover phase survive');
    assert.ok(r.timeHover && typeof r.timeHover.error === 'string', 'timeHover.error embedded');
    assert.match(r.timeHover.error, /HOVER_SKIPPED_ENHANCED_MODE/);
    assert.match(r.note, /timeHover failed \(hover phase ONLY/, 'note quarantines the failure to the hover phase');
    assert.match(r.note, /retry the timestamp separately via probe\.timestamp/, 'note routes the retry');
  });

  it('pickCensusIndices edges through census(): single record, pair, oversized samples', async () => {
    const one = makeCensusTools([cardHtml(1)]);
    const r1 = await one.tools.census({ containerSel: 'div.card' });
    assert.equal(r1.total, 1);
    assert.deepEqual(r1.sampled, [0]);
    assert.match(r1.note, /only 1 sample\(s\) censused — coverage CANNOT certify generalization/, 'small-sample note replaces the k/n teaching');

    const two = makeCensusTools([cardHtml(1), cardHtml(2)]);
    const r2 = await two.tools.census({ containerSel: 'div.card' });
    assert.deepEqual(r2.sampled, [0, 1]);

    // samples:5 across 7 records — expected computed by the SAME formula
    // the code uses: Math.min(total-1, Math.round((i*(total-1))/(n-1))).
    const seven = [];
    for (let i = 0; i < 7; i++) seven.push(cardHtml(i + 1));
    const r7 = await makeCensusTools(seven).tools.census({ containerSel: 'div.card', samples: 5 });
    const expected = [];
    for (let i = 0; i < 5; i++) expected.push(Math.min(6, Math.round((i * 6) / 4)));
    assert.deepEqual(r7.sampled, Array.from(new Set(expected)));

    const three = makeCensusTools([cardHtml(1), cardHtml(2), cardHtml(3)]);
    const r3 = await three.tools.census({ containerSel: 'div.card', samples: 9 });
    assert.deepEqual(r3.sampled, [0, 1, 2], 'samples above the population clamps to every record');
  });

  it('skipped samples drop out of `sampled` too — indices stay aligned with the docs actually parsed (review #3)', async () => {
    const records = [cardHtml(1), { __c_html: '' }, cardHtml(3)];
    const { tools } = makeCensusTools(records);
    const r = await tools.census({ containerSel: 'div.card' });
    assert.equal(r.total, 3, 'total reflects the population, not the parseable subset');
    assert.deepEqual(r.sampled, [0, 2], 'sampled names the SURVIVING indices only');
    assert.equal(r.skippedSamples, 1, 'the skipped sample is disclosed');
    assert.ok(r.lanes && r.lanes.time && r.lanes.time.length, 'lanes still computed from the parseable samples');
    // Every lane's coverage denominator must match the sampled count — the
    // misalignment bug fed lane scans htmls[di] of the WRONG sample.
    for (const lane of Object.keys(r.lanes)) {
      for (const e of r.lanes[lane]) {
        const [k, n] = e.coverage.split('/').map(Number);
        assert.ok(n === r.sampled.length, 'coverage denominator matches the parsed-sample count');
        assert.ok(k <= n, 'coverage never exceeds the parsed-sample count');
      }
    }
  });

  it('an HTML-capped sample is disclosed via truncatedSamples + note teaching (review #9)', async () => {
    const capped = '<div class="card"><a class="ttl" href="/post/9?story=1009">T9</a><span class="ts">9 days ago</span><span>partial ta' +
      '<!--TRUNCATED: element HTML capped at 50000 of 120000 chars-->';
    const r = await makeCensusTools([cardHtml(1), capped, cardHtml(3)]).tools.census({ containerSel: 'div.card' });
    assert.equal(r.truncatedSamples, 1, 'the capped sample is counted');
    assert.match(r.note, /1 sampled container\(s\) were HTML-capped mid-markup/, 'note names the cut');
    assert.match(r.note, /prefer structural selectors \(tag\+class\)/, 'note teaches the structural route');
  });

  it('epoch-digit values (10-13 pure digits) are NOT identity — query:ts stays out of hrefIdentity (review #11)', async () => {
    const tsCard = (n) => '<div class="card">' +
      '<a class="ttl" href="/post/' + n + '?ts=' + (1760000000000 + n) + '&story=' + (1000 + n) + '">Title ' + n + '</a>' +
      '<span class="ts">' + n + ' days ago</span>' +
      '</div>';
    const r = await makeCensusTools([tsCard(1), tsCard(2), tsCard(3)]).tools.census({ containerSel: 'div.card' });
    assert.ok(r.hrefIdentity && r.hrefIdentity.some((e) => e.token === 'query:story'), 'the real identity token still diffed');
    assert.ok(!r.hrefIdentity.some((e) => e.token === 'query:ts'), 'epoch cache-buster never reported as identity');
    assert.match(r.note, /confirm the chosen token is constant WITHIN one card/, 'candidate-not-binding teaching rides the note');
  });

  it('aria lane escapes class tokens containing CSS-special characters (review #27)', async () => {
    const card = (n) => '<div class="card"><a class="ttl" href="/post/' + n + '?story=' + (1000 + n) + '">T</a>' +
      '<span class="tip:x' + n + '" aria-labelledby="tt' + n + '">' + n + ' days ago</span></div>';
    const r = await makeCensusTools([card(1), card(2), card(3)]).tools.census({ containerSel: 'div.card' });
    assert.ok(r.lanes.aria && r.lanes.aria.length, 'aria lane present');
    // The selector must carry the escaped form (tip\:x…) — an unescaped
    // ':' would make it an invalid pseudo-class-bearing selector.
    for (const e of r.lanes.aria) {
      if (/^span\.tip/.test(e.selector)) {
        assert.ok(/\\:/.test(e.selector), 'class token CSS-escaped: ' + e.selector);
      }
    }
  });

  it('svg-noise cards do not pollute the lanes (review #28 judgment: no cleaner pre-pass needed)', async () => {
    // The recorded call: findFieldCandidates scores leaves; svg/path leaves
    // carry no text and no time/count/url/id attributes, so they score
    // nothing in any lane — and wiring applyClean BEFORE the parse would
    // STRIP the hidden/tooltip-classed aria carriers the aria lane exists
    // to find (cleanPageHtml removes [aria-hidden] and class*=tooltip).
    // Output is already bounded (maxPerLane entries; 50K element cap).
    let svgNoise = '';
    for (let i = 0; i < 40; i++) svgNoise += '<svg viewBox="0 0 24 24"><path d="M' + i + ' 0L24 ' + i + 'z"/></svg>';
    const card = (n) => '<div class="card">' + svgNoise +
      '<a class="ttl" href="/post/' + n + '?story=' + (1000 + n) + '">Title ' + n + '</a>' +
      '<span class="ts">' + n + ' days ago</span></div>';
    const r = await makeCensusTools([card(1), card(2), card(3)]).tools.census({ containerSel: 'div.card' });
    assert.ok(r.lanes.time && r.lanes.time.some((c) => c.selector === 'span.ts'), 'time lane unaffected by the noise');
    const allTexts = [];
    for (const lane of Object.keys(r.lanes)) for (const e of r.lanes[lane]) allTexts.push((e.texts || []).join(' '));
    assert.ok(!allTexts.join(' ').includes('viewBox'), 'svg markup never leaks into lane texts');
  });

  it('timeoutMs: invalid type teaches; valid value forwards to the executor (review #5)', async () => {
    const bad = await makeCensusTools([cardHtml(1)]).tools.census({ containerSel: 'div.card', timeoutMs: 'lots' });
    assert.match(bad.error, /timeoutMs must be a positive number of milliseconds \(default 30000, max 90000\)/);

    let forwarded = null;
    const observationLog = createObservationLog();
    const tools = createProbeTools({
      executeDsl: async (snippet, opts) => { forwarded = opts; return [{ __c_html: cardHtml(1) }]; },
      observationLog
    });
    const r = await tools.census({ containerSel: 'div.card', timeoutMs: 123456 });
    assert.ok(r.lanes, 'census ran');
    assert.deepEqual(forwarded, { timeoutMs: 90000 }, 'clamped to the 90s ceiling and forwarded');
  });

  it('a snippet budget error carries the census-shaped route, not the generic hover teaching (review #5)', async () => {
    const observationLog = createObservationLog();
    const tools = createProbeTools({
      executeDsl: async () => ({ error: 'snippet exceeded 30000ms — size the batch (each hovered anchor burns ~5-10s…)' }),
      observationLog
    });
    const r = await tools.census({ containerSel: 'div.card' });
    assert.match(r.error, /snippet exceeded 30000ms/);
    assert.match(r.error, /for census: narrow containerSel to the repeating card/);
    assert.match(r.error, /per-field probes \(probe\.sample\) remain the fallback/);
  });

  it('aria lane caps at 4 entries however many distinct carriers the card carries', async () => {
    let carriers = '';
    for (let i = 1; i <= 25; i++) carriers += '<i class="c' + i + '" aria-labelledby="id' + i + '">v' + i + '</i>';
    const card = '<div class="card"><a class="ttl" href="/post/1?story=1001">T</a><span class="ts">1 day ago</span>' + carriers + '</div>';
    const r = await makeCensusTools([card, card, card]).tools.census({ containerSel: 'div.card' });
    assert.ok(r.lanes.aria, 'aria lane present');
    assert.ok(r.lanes.aria.length <= 4, 'entries capped at min(4, maxPerLane) — got ' + r.lanes.aria.length);
  });

  it('hrefIdentity keeps identity query tokens but never utm_* transport decoration', async () => {
    const utmCard = (n) => '<div class="card">' +
      '<a class="ttl" href="/post/' + n + '?utm_source=1234567&story=' + (1000 + n) + '">Title ' + n + '</a>' +
      '<span class="ts">' + n + ' days ago</span>' +
      '</div>';
    const r = await makeCensusTools([utmCard(1), utmCard(2), utmCard(3)]).tools.census({ containerSel: 'div.card' });
    assert.ok(Array.isArray(r.hrefIdentity) && r.hrefIdentity.length, 'hrefIdentity present');
    assert.ok(r.hrefIdentity.some((e) => e.token === 'query:story'), 'query:story diffed');
    assert.ok(!r.hrefIdentity.some((e) => /utm/i.test(e.token)), 'utm_* never reported as identity (even with an id-shaped value)');
  });

  it('an unparseable href entry is skipped without throwing', async () => {
    const badCard = (n) => '<div class="card">' +
      '<a class="bad" href="http://[invalid">broken</a>' +
      '<a class="ttl" href="/post/' + n + '?story=' + (1000 + n) + '">Title ' + n + '</a>' +
      '<span class="ts">' + n + ' days ago</span>' +
      '</div>';
    const r = await makeCensusTools([badCard(1), badCard(2), badCard(3)]).tools.census({ containerSel: 'div.card' });
    assert.ok(r.lanes && r.lanes.url, 'lanes computed');
    assert.ok(r.hrefIdentity && r.hrefIdentity.some((e) => e.token === 'query:story'), 'valid links still diffed after the bad one is skipped');
  });
});

describe('probe.census steering wiring (source audit)', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const ST = fs.readFileSync(path.join(__dirname, '../lib/session-tools.js'), 'utf8');
  const RS = fs.readFileSync(path.join(__dirname, '../lib/research-session.js'), 'utf8');
  const PT = fs.readFileSync(path.join(__dirname, '../lib/probe-tools.js'), 'utf8');

  it('session-tools registers the tool, spec entry, and census-first methodology routing', () => {
    // Review #4 replaced the plain wrapProbe registration with a wrapper
    // that mirrors the probe.timestamp tooltipRoute bookkeeping — pin the
    // NEW shape (wrapProbe still runs inside it; hover:true feeds evidence).
    assert.match(ST, /'probe\.census': \(async \(args, ctx\) => \{\s*\n\s*const r = await wrapProbe\(probes\.census, 'probe\.census'\)\(args, ctx\)/);
    assert.match(ST, /args\.hover === true[\s\S]*?r\.timeHover && !r\.timeHover\.error[\s\S]*?tooltipRoute\.probeTimestampCalls \+= 1/, 'census{hover:true} bumps the tooltip-route evidence');
    assert.match(ST, /name: 'probe\.census'/);
    assert.match(ST, /PAGE-LEVEL FIELD CENSUS/);
    assert.match(ST, /run ONE probe\.census\{containerSel, hover:true\}/, 'methodology rule 2 routes census-first');
    assert.match(ST, /NEVER walk fields serially/, 'serial walking explicitly discouraged');
  });

  it('research-session gives the census receipt a 12000-char budget (review #2: worst realistic census measured 10447)', () => {
    assert.match(RS, /'probe\.census': 12000/);
  });

  it('census block carries no site tokens (universality)', () => {
    const start = PT.indexOf('async function census(');
    const blockStart = PT.lastIndexOf('// Speed track (user directive 2026-09-29)', start);
    const block = PT.slice(blockStart > -1 ? blockStart : start, start + 6000);
    assert.ok(block.length > 1000, 'census block located');
    assert.ok(!/facebook|twitter|linkedin|tiktok|reddit|\bfb\b/i.test(block), 'site-agnostic');
  });
});

describe('probe.census population-suspicion + retarget teaching (175th round)', () => {
  it('a small population flags the wrong-container suspicion in the note', async () => {
    const { tools } = makeCensusTools([cardHtml(1), cardHtml(2)]);
    const r = await tools.census({ containerSel: 'div.card' });
    assert.match(r.note, /only 2 container\(s\) matched — a population this small is suspicious/,
      'the live 175th incident: the first census matched 4 recommendation cards and the model burned 35 turns serial-hunting before the contract');
    assert.match(r.note, /re-target containerSel and RE-CENSUS/);
  });

  it('a healthy population skips the suspicion clause but keeps the retarget teaching', async () => {
    const records = [];
    for (let i = 0; i < 7; i++) records.push(cardHtml(i + 1));
    const { tools } = makeCensusTools(records);
    const r = await tools.census({ containerSel: 'div.card' });
    assert.doesNotMatch(r.note, /population this small is suspicious/);
    assert.match(r.note, /Changing containerSel\? re-run the census on the new selector/,
      'after ANY retarget the census is the cheap re-grounding — never a serial per-field fallback');
  });
});

describe('probe.census A+B batch (175th round): bounded reads, coverage fidelity, within-card variance', () => {
  function makeBoundedTools(n, opts) {
    const o = opts || {};
    const records = [];
    for (let i = 0; i < n; i++) records.push(cardHtml(i + 1));
    const observationLog = createObservationLog();
    const calls = [];
    const tools = createProbeTools({
      executeDsl: async (snippet) => {
        calls.push(snippet);
        if (/\$extractWithHover\(/.test(snippet)) {
          return [{ __t_label: '', __t_aria: '', __t_text: 'September 11, 2026', hovercards: [] }];
        }
        if (/\$count\(/.test(snippet)) return o.count != null ? o.count : records.length;
        if (/containerRange/.test(snippet)) {
          const m = snippet.match(/"containerRange":\[(\d+)/);
          const i = m ? Number(m[1]) : 0;
          const h = records[i];
          return [{ __c_html: (h && typeof h === 'object') ? h.__c_html : h }];
        }
        return records.map((h) => ({ __c_html: h }));
      },
      observationLog
    });
    return { tools, calls, observationLog };
  }

  it('#35: populations above the full-read bound sample through bounded range reads', async () => {
    const { tools, calls } = makeBoundedTools(50);
    const r = await tools.census({ containerSel: 'div.card' });
    assert.equal(r.total, 50);
    assert.deepEqual(r.sampled, [0, 25, 49], 'even sampling over the live count');
    assert.equal(r.boundedRead, true);
    assert.match(r.note, /bounded range reads/);
    const rangeCalls = calls.filter((s) => /containerRange/.test(s));
    assert.equal(rangeCalls.length, 3, 'three per-index reads — the relay never carries all 50');
    assert.ok(r.lanes.time && r.lanes.time.length, 'lanes still built from the sampled containers');
  });

  it('#32: zero population reaches the honest receipt via the pre-count (production shape)', async () => {
    const { tools } = makeBoundedTools(3, { count: 0 });
    const r = await tools.census({ containerSel: 'div.nope' });
    assert.equal(r.total, 0);
    assert.match(r.note, /0 containers matched/);
  });

  it('#30: lane texts come from the FIRST match production reads, not the scored leaf', async () => {
    // Two leaves share tag+first-class: the first carries chrome text (never
    // scores as time-like), the second carries the date (scores). Production
    // $extractList reads the FIRST — the receipt must show that value, or a
    // class collision silently binds the wrong element.
    const dupCard = (n) => '<div class="card">' +
      '<span class="ts">Sponsored</span>' +
      '<span class="ts">' + n + ' days ago</span>' +
      '</div>';
    const records = [dupCard(1), dupCard(2), dupCard(3)];
    const observationLog = createObservationLog();
    const tools = createProbeTools({
      executeDsl: async (snippet) => {
        if (/\$count\(/.test(snippet)) return records.length;
        return records.map((h) => ({ __c_html: h }));
      },
      observationLog
    });
    const r = await tools.census({ containerSel: 'div.card' });
    const ts = r.lanes.time.find((c) => c.selector === 'span.ts');
    assert.ok(ts, 'span.ts in the time lane (from the scored leaf)');
    assert.equal(ts.texts[0], 'Sponsored', 'texts show the FIRST-match value production would bind');
    assert.equal(ts.coverage, '3/3');
  });

  it('#33: a token varying WITHIN one card is per-link decoration, excluded from hrefIdentity', async () => {
    const card = (n) => '<div class="card">' +
      '<a class="l1" href="/x?sid=s10001' + n + '&pid=p100000' + n + '">a</a>' +
      '<a class="l2" href="/y?sid=s20001' + n + '">b</a>' +
      '</div>';
    const records = [card(1), card(2), card(3)];
    const observationLog = createObservationLog();
    const tools = createProbeTools({
      executeDsl: async (snippet) => {
        if (/\$count\(/.test(snippet)) return records.length;
        return records.map((h) => ({ __c_html: h }));
      },
      observationLog
    });
    const r = await tools.census({ containerSel: 'div.card' });
    assert.ok(Array.isArray(r.hrefIdentity), 'hrefIdentity present');
    assert.ok(!r.hrefIdentity.some((e) => e.token === 'query:sid'),
      'sid differs between links INSIDE each card — per-link decoration, not identity');
    const pid = r.hrefIdentity.find((e) => e.token === 'query:pid');
    assert.ok(pid, 'pid is single-per-card and varies across cards — the identity candidate');
    assert.deepEqual(pid.samples, ['p1000001', 'p1000002', 'p1000003']);
  });
});

// 177c round (live: the default timestamp union matched ZERO anchors inside
// search-post containers — their anchors are plain links, not
// labelledby-carrying feed-card spans — while the census's own lanes held
// the real anchor shapes). A vacuous timeHover self-heals ONCE with the
// lanes' top-coverage time/aria/url selectors as the anchor union.
describe('177c round: vacuous timeHover self-heals from the census lanes', () => {
  function vacuousTools() {
    const records = [cardHtml(1), cardHtml(2), cardHtml(3)];
    const hoverCalls = [];
    const observationLog = createObservationLog();
    const tools = createProbeTools({
      executeDsl: async (snippet) => {
        if (/\$extractWithHover\(/.test(snippet)) {
          // Default union in the anchorSel: anchorLog EMPTY (vacuous shape).
          // Lane-derived retry (snippet carries the lane selector union):
          // the one-card dance captures a full absolute.
          const isRetry = /span\.ts/.test(snippet);
          hoverCalls.push(isRetry ? 'retry' : 'default');
          if (!isRetry) {
            return [{ __t_label: '', __t_aria: '', __t_text: '', hovercards: [], anchorLog: [] }];
          }
          return [{ __t_label: '', __t_aria: '', __t_text: 'September 11, 2026', hovercards: [] }];
        }
        if (/\$count\(/.test(snippet)) return records.length;
        return records.map((h) => ({ __c_html: h }));
      },
      observationLog
    });
    return { tools, hoverCalls };
  }

  it('a zero-anchor timeHover retries once with the lane selectors and discloses censusRetry', async () => {
    const { tools, hoverCalls } = vacuousTools();
    const r = await tools.census({ containerSel: 'div.card', hover: true });
    assert.deepEqual(hoverCalls, ['default', 'retry'], 'exactly one self-heal retry');
    assert.equal(r.timeHover.absolute, 'September 11, 2026');
    assert.ok(r.timeHover.censusRetry, 'the retry is disclosed');
    assert.match(r.timeHover.censusRetry.to, /span\.ts/);
    assert.match(r.timeHover.censusRetry.from, /default union/);
  });

  it('no retry when the default dance already captured something', async () => {
    const records = [cardHtml(1), cardHtml(2)];
    const hoverCalls = [];
    const tools = createProbeTools({
      executeDsl: async (snippet) => {
        if (/\$extractWithHover\(/.test(snippet)) {
          hoverCalls.push('called');
          return [{ __t_label: '', __t_aria: '', __t_text: 'September 11, 2026', hovercards: [] }];
        }
        if (/\$count\(/.test(snippet)) return records.length;
        return records.map((h) => ({ __c_html: h }));
      },
      observationLog: createObservationLog()
    });
    const r = await tools.census({ containerSel: 'div.card', hover: true });
    assert.equal(hoverCalls.length, 1, 'no retry on a productive dance');
    assert.ok(!r.timeHover.censusRetry);
  });
});
