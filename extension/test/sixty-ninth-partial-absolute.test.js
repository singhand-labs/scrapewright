// Sixty-ninth log (session rs-*, otherwise the cleanest yet): probe.timestamp
// returned absolute:"August 2" via labelledby — a month-day WITHOUT a year —
// and the binary relative flag blessed it as a full absolute; the model bound
// the cheap labelledby value, never touched the hover-tooltip full date
// (read:'hoverPopover' zero uses), and shipped with 5/10 postTime relative +
// 5/10 yearless month-days, all disclosed but all avoidable.
//
// Fix under test: full-vs-partial absolute classification across the
// timestamp layer — hasYearToken (wizard-utils), probe.timestamp candidate
// flags + pick order + teaching note, domTimestamp twin, the
// detectRelativeTimestamps partial census, the knowledge-unit sentence.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

const WU = require('../lib/wizard-utils');
const { createProbeTools } = require('../lib/probe-tools');
const KNOWLEDGE_UNITS = require('../lib/knowledge-units').KNOWLEDGE_UNITS;

const FORBIDDEN = /facebook|twitter|linkedin|tiktok|reddit|\bfb\b/i;

// ---------------------------------------------------------------------------
// hasYearToken units.
// ---------------------------------------------------------------------------

describe('sixty-ninth log: hasYearToken', () => {
  it('classifies the spec corpus', () => {
    assert.equal(WU.hasYearToken('August 2'), false);
    assert.equal(WU.hasYearToken('August 2, 2026'), true);
    assert.equal(WU.hasYearToken('2026年6月25日'), true);
    assert.equal(WU.hasYearToken('4 days ago'), false);
    assert.equal(WU.hasYearToken('2024-03-05'), true);
  });

  it('clock-time-only and month-day+clock shapes lack a year', () => {
    assert.equal(WU.hasYearToken('August 23 at 5:30 PM'), false);
    assert.equal(WU.hasYearToken('3/9 2:30 PM'), false);
    assert.equal(WU.hasYearToken('September 11, 2026 at 1:43 PM'), true);
    assert.equal(WU.hasYearToken(''), false);
    assert.equal(WU.hasYearToken(null), false);
  });
});

// ---------------------------------------------------------------------------
// probe.timestamp behavioral (the 56th/64th-log createProbeTools stub).
// ---------------------------------------------------------------------------

function makeTools(impl) {
  return createProbeTools({ executeDsl: async () => impl() });
}

describe('sixty-ninth log: probe.timestamp partial-absolute classification', () => {
  it('labelledby month-day becomes the absolute but is flagged partial with the teaching note (the exact incident)', async () => {
    const tools = makeTools(() => [{
      __t_label: 'August 2',
      __t_aria: '',
      __t_text: '4 days ago',
      hovercards: [{ labelledbyText: 'August 2', anchorText: 'August 2' }]
    }]);
    const r = await tools.timestamp({ containerSel: 'div.card', index: 0 });
    assert.equal(r.absolute, 'August 2');
    assert.equal(r.absoluteSource, 'labelledby');
    assert.match(r.note, /lacks a YEAR|partial/i);
    const lbl = r.candidates.find((c) => c.value === 'August 2');
    assert.equal(lbl.partial, true, 'the month-day carries partial:true');
    const rel = r.candidates.find((c) => c.value === '4 days ago');
    assert.equal(rel.partial, false, 'a relative age is never partial');
  });

  it('a FULL absolute outranks the partial month-day regardless of order', async () => {
    const tools = makeTools(() => [{
      __t_label: 'August 2',
      __t_aria: '',
      __t_text: '4 days ago',
      hovercards: [{ labelledbyText: 'August 2', anchorText: 'August 2', htmlSnippet: '<div>September 11, 2026 at 1:43 PM</div>' }]
    }]);
    const r = await tools.timestamp({ containerSel: 'div.card', index: 0 });
    assert.equal(r.absolute, 'September 11, 2026 at 1:43 PM');
    assert.equal(r.absoluteSource, 'hover.popoverText');
    assert.ok(!r.note || !/lacks a YEAR/.test(r.note), 'no partial note when the chosen absolute is full');
  });

  it('relative-only keeps its own distinct note (the two cases never merge)', async () => {
    const tools = makeTools(() => [{ __t_label: '4 days ago', __t_aria: '', __t_text: '4 days ago', hovercards: [] }]);
    const r = await tools.timestamp({ containerSel: 'div.card', index: 0 });
    assert.equal(r.absolute, null);
    assert.match(r.note, /only RELATIVE/i);
    assert.doesNotMatch(r.note, /lacks a YEAR/);
  });
});

// ---------------------------------------------------------------------------
// domTimestamp behavioral — the sixty-fifth-log vm/JSDOM factory.
// ---------------------------------------------------------------------------

function readSrc(rel) {
  return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
}
function sliceFn(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.ok(start > -1, 'marker not found: ' + startMarker);
  const end = source.indexOf(endMarker, start);
  assert.ok(end > start, 'end marker not found after start: ' + endMarker);
  return source.slice(start, end);
}

const CS_SRC = readSrc('content-script.js');
const TS_SLICE = sliceFn(CS_SRC, 'var TS_MAX_HOVER_ANCHORS', '\n  async function domExists(');
const HARVEST_SLICE =
  sliceFn(CS_SRC, 'function resolveLabelledbyText(', '\n  async function domLabelledby') + '\n' +
  sliceFn(CS_SRC, 'function harvestAnchorLabel(', '\n  async function domHover(');

function tsContext(dom, hoverImpl) {
  const diags = [];
  const card = dom.window.document.getElementById('card');
  const ctx = {
    document: dom.window.document,
    querySelectorAllDeep: (sel) => (sel === '#card' ? [card] : []),
    notifyBackgroundDiagnostic: (name, payload) => { diags.push({ name, payload }); },
    domHover: hoverImpl,
    sendDebugLog: () => {}
  };
  vm.createContext(ctx);
  vm.runInContext(HARVEST_SLICE + '\n' + TS_SLICE + '\nthis.__ts = domTimestamp;', ctx);
  return { ctx, diags };
}

describe('sixty-ninth log: domTimestamp partial-absolute twin', () => {
  it('labelledby month-day only → absolute chosen, partial flagged, note fires', async () => {
    const dom = new JSDOM(
      '<div id="card"><a class="ts" href="?x" aria-labelledby="tl"><span id="tl">August 2</span></a></div>',
      { url: 'https://example.com/page' }
    );
    const { ctx } = tsContext(dom, async () => ({ hovered: false, htmlSnippet: null }));
    const r = await ctx.__ts('#card', { anchorSel: '.ts', timeoutMs: 10 });
    assert.equal(r.result.absolute, 'August 2');
    assert.ok(['text', 'labelledby'].includes(r.result.absoluteSource), 'source: ' + r.result.absoluteSource);
    assert.match(r.result.note, /lacks a YEAR|partial/i);
    assert.ok(r.result.candidates.every((c) => c.partial !== undefined), 'candidates carry the partial flag');
  });

  it('a partial absolute does NOT satisfy the hover stop-gate; the full-date popover wins', async () => {
    const dom = new JSDOM(
      '<div id="card"><a class="ts" href="?x" aria-labelledby="tl"><span id="tl">August 2</span></a></div>',
      { url: 'https://example.com/page' }
    );
    let hovers = 0;
    const { ctx } = tsContext(dom, async () => {
      hovers += 1;
      return { hovered: true, htmlSnippet: '<div role="tooltip"><div>August 2, 2024 at 3:14 PM</div></div>' };
    });
    const r = await ctx.__ts('#card', { anchorSel: '.ts', timeoutMs: 10 });
    assert.equal(hovers, 1, 'the month-day labelledby value does not stop the hover hunt');
    assert.equal(r.result.absolute, 'August 2, 2024 at 3:14 PM');
    assert.equal(r.result.absoluteSource, 'popoverText');
    assert.ok(!r.result.note || !/lacks a YEAR/.test(r.result.note), 'no partial note on a full-date win');
  });

  it('full date via popoverText → no partial note (65th-log behavior preserved)', async () => {
    const dom = new JSDOM(
      '<div id="card"><a class="ts" href="?x" aria-labelledby="tl"><span id="tl">3 days ago</span></a></div>',
      { url: 'https://example.com/page' }
    );
    const { ctx } = tsContext(dom, async () => ({
      hovered: true,
      htmlSnippet: '<div role="tooltip"><div>Friday, September 11, 2026 at 1:43 AM</div></div>'
    }));
    const r = await ctx.__ts('#card', { anchorSel: '.ts', timeoutMs: 10 });
    assert.equal(r.result.absolute, 'September 11, 2026 at 1:43 AM');
    assert.ok(!r.result.note, 'no note on a clean full-date harvest');
  });

  it('TS_hasYear regexes stay in parity with wizard-utils hasYearToken (twins scope)', () => {
    const WU_SRC = readSrc('lib/wizard-utils.js');
    const wuIdx = WU_SRC.indexOf('function hasYearToken(');
    assert.ok(wuIdx > -1);
    const wuBlock = WU_SRC.slice(wuIdx, wuIdx + 400);
    const ctx = {};
    vm.createContext(ctx);
    vm.runInContext(TS_SLICE + '\nthis.__hy = TS_hasYear;', ctx);
    for (const [v, expected] of [['August 2', false], ['August 2, 2026', true], ['2026年6月25日', true], ['4 days ago', false], ['2024-03-05', true], ['August 23 at 5:30 PM', false]]) {
      assert.equal(ctx.__hy(v), expected, 'TS_hasYear(' + JSON.stringify(v) + ')');
    }
    // The regex pair itself must appear in both sources (drift-guard).
    const YEAR_RE = '/\\b(?:19|20)\\d{2}\\b/';
    const CJK_YEAR_RE = '/\\d{4}\\s*年/';
    assert.ok(TS_SLICE.includes(YEAR_RE) && WU_SRC.includes(YEAR_RE), 'shared 4-digit year regex');
    assert.ok(TS_SLICE.includes(CJK_YEAR_RE) && wuBlock.includes(CJK_YEAR_RE), 'shared CJK 年 regex');
  });
});

// ---------------------------------------------------------------------------
// Detector + knowledge unit + universality.
// ---------------------------------------------------------------------------

describe('sixty-ninth log: detectRelativeTimestamps partial-absolute census', () => {
  const TIME_SCHEMA = { type: 'object', required: ['posts'], properties: { posts: { type: 'array', items: { type: 'object', required: ['postTime'], properties: {
    postTime: { type: 'string' }, title: { type: 'string' }
  } } } } };

  it("['August 2','4 days ago'] → one entry sampling both classes, note names the no-year class", () => {
    const r = WU.detectRelativeTimestamps({ posts: [
      { postTime: 'August 2', title: 'a' },
      { postTime: '4 days ago', title: 'b' }
    ] }, TIME_SCHEMA);
    assert.equal(r.length, 1);
    assert.equal(r[0].relativeCount, 1);
    assert.equal(r[0].partialAbsoluteCount, 1);
    assert.equal(r[0].partialSample, 'August 2');
    assert.match(r[0].sampleValue, /August 2|4 days ago/);
    assert.match(r[0].note, /no year — partial absolute/);
    assert.match(r[0].note, /hover tooltip/);
  });

  it('year-carrying absolutes stay clean (no entry)', () => {
    assert.equal(WU.detectRelativeTimestamps({ posts: [{ postTime: 'August 2, 2026 at 3:14 PM', title: 'a' }] }, TIME_SCHEMA).length, 0);
    assert.equal(WU.detectRelativeTimestamps({ posts: [{ postTime: '2024-03-05', title: 'a' }] }, TIME_SCHEMA).length, 0);
  });

  it('a partial-only scalar time field is flagged too', () => {
    const schema = { type: 'object', required: ['updatedAt'], properties: { updatedAt: { type: 'string' } } };
    const r = WU.detectRelativeTimestamps({ updatedAt: 'August 2' }, schema);
    assert.equal(r.length, 1);
    assert.equal(r[0].partialAbsoluteCount, 1);
    assert.match(r[0].note, /no year — partial absolute/);
  });
});

describe('sixty-ninth log: knowledge unit + universality', () => {
  it('relative-timestamp-rebind teaches the PARTIAL absolute class', () => {
    const u = KNOWLEDGE_UNITS.find((x) => x.id === 'relative-timestamp-rebind');
    assert.ok(u);
    assert.match(u.body, /PARTIAL absolutes/);
    assert.match(u.body, /hoverPopover/);
  });

  it('universality: none of the new strings carry site tokens', () => {
    const PT = readSrc('lib/probe-tools.js');
    const tsIdx = PT.indexOf('async function timestamp(');
    const tsBlock = PT.slice(tsIdx, PT.indexOf('async function loginState(', tsIdx));
    assert.ok(!FORBIDDEN.test(tsBlock), 'probe.timestamp block');
    const detIdx = CS_SRC.indexOf('async function domTimestamp(');
    assert.ok(!FORBIDDEN.test(CS_SRC.slice(detIdx - 4200, CS_SRC.indexOf('\n  async function domExists(', detIdx))), 'domTimestamp block incl. TS constants');
    const wuSrc = readSrc('lib/wizard-utils.js');
    const hyIdx = wuSrc.indexOf('function hasYearToken(');
    assert.ok(!FORBIDDEN.test(wuSrc.slice(hyIdx - 600, hyIdx + 600)), 'hasYearToken block');
    const dtrIdx = wuSrc.indexOf('function detectRelativeTimestamps(');
    assert.ok(!FORBIDDEN.test(wuSrc.slice(dtrIdx, wuSrc.indexOf('function formatDuplicateRecordsSignal', dtrIdx))), 'detector block');
    const u = KNOWLEDGE_UNITS.find((x) => x.id === 'relative-timestamp-rebind');
    assert.ok(!FORBIDDEN.test(u.body), 'knowledge unit body');
  });
});
