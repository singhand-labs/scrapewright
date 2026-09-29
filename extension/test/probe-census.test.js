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
        return [{
          __t_label: '',
          __t_aria: '',
          __t_text: 'September 11, 2026',
          hovercards: []
        }];
      }
      return records.map((h) => ({ __c_html: h }));
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

describe('probe.census steering wiring (source audit)', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const ST = fs.readFileSync(path.join(__dirname, '../lib/session-tools.js'), 'utf8');
  const RS = fs.readFileSync(path.join(__dirname, '../lib/research-session.js'), 'utf8');
  const PT = fs.readFileSync(path.join(__dirname, '../lib/probe-tools.js'), 'utf8');

  it('session-tools registers the tool, spec entry, and census-first methodology routing', () => {
    assert.match(ST, /'probe\.census': wrapProbe\(probes\.census, 'probe\.census'\)/);
    assert.match(ST, /name: 'probe\.census'/);
    assert.match(ST, /PAGE-LEVEL FIELD CENSUS/);
    assert.match(ST, /run ONE probe\.census\{containerSel, hover:true\}/, 'methodology rule 2 routes census-first');
    assert.match(ST, /Do NOT walk fields serially/, 'serial walking explicitly discouraged');
  });

  it('research-session gives the census receipt an 8000-char budget', () => {
    assert.match(RS, /'probe\.census': 8000/);
  });

  it('census block carries no site tokens (universality)', () => {
    const start = PT.indexOf('async function census(');
    const blockStart = PT.lastIndexOf('// Speed track (user directive 2026-09-29)', start);
    const block = PT.slice(blockStart > -1 ? blockStart : start, start + 6000);
    assert.ok(block.length > 1000, 'census block located');
    assert.ok(!/facebook|twitter|linkedin|tiktok|reddit|\bfb\b/i.test(block), 'site-agnostic');
  });
});
