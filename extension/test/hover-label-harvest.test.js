// Forty-second log: hovercard entries must harvest the ANCHOR's accessible
// label at capture time. Live evidence: the timestamp anchors the model
// hovered DID mount their full-time tooltips (the user watched them pop),
// $extractWithHover captured those tooltips as hovercards — and the step
// assembly threw them away because the entry carried no structured text
// (only htmlSnippet to regex) while the separately-read labelledby field
// hit a partially-mounted reference ("June 21" instead of the full time).
// The universal fix, per the user's design directive — dynamic content
// triggered by a simulated action must be read back into THIS tool in the
// SAME operation, before later actions can wash it away: domHover resolves
// the anchor's aria-labelledby/aria-describedby referenced text BEFORE the
// dismiss (mouseout unmounts the very text the reference points at) and
// attaches labelledbyText/labelledbyAttr/labelledbyNote to the entry.
const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

const { extractWithHoverRecords } = require('../lib/list-extract-ops');

function readSrc(rel) {
  return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
}

function setupDOM(html) {
  const dom = new JSDOM(html, { url: 'https://example.com/page' });
  global.document = dom.window.document;
  global.window = dom.window;
  global.Node = dom.window.Node;
  return dom;
}

function sliceFn(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.ok(start > -1, 'marker not found: ' + startMarker);
  const end = source.indexOf(endMarker, start);
  assert.ok(end > start, 'end marker not found after start: ' + endMarker);
  return source.slice(start, end);
}

// Evaluates harvestAnchorLabel + its dependency (resolveLabelledbyText) in a
// vm context whose global document is the JSDOM document — the production
// topology (content-script inner functions close over the page document).
function loadHarvestFn(dom) {
  const src = readSrc('content-script.js');
  const resolve = sliceFn(src, 'function resolveLabelledbyText(', '\n  async function domLabelledby');
  const harvest = sliceFn(src, 'function harvestAnchorLabel(', '\n  async function domHover(');
  const ctx = { document: dom.window.document };
  vm.createContext(ctx);
  vm.runInContext(resolve + '\n' + harvest + '\nthis.__fn = harvestAnchorLabel;', ctx);
  return ctx.__fn;
}

describe('forty-second log: extractWithHoverRecords forwards the anchor-label harvest', () => {
  beforeEach(() => {
    setupDOM('<!DOCTYPE html><html><body><div id="c1"><a class="a" href="/x">card</a></div></body></html>');
  });

  it('carries labelledbyText/labelledbyAttr from the hover result into the hovercards entry', async () => {
    const containers = [document.getElementById('c1')];
    const records = await extractWithHoverRecords(
      containers,
      { content: { selector: '.a' } },
      { anchorSel: '.a' },
      async () => ({
        hovered: true,
        htmlSnippet: '<div role="none"></div>',
        labelledbyText: 'June 21, 2024 at 3:15 PM',
        labelledbyAttr: 'aria-labelledby'
      })
    );
    const hc = records[0].hovercards[0];
    assert.equal(hc.labelledbyText, 'June 21, 2024 at 3:15 PM');
    assert.equal(hc.labelledbyAttr, 'aria-labelledby');
    assert.equal(hc.labelledbyNote, null);
  });

  it('entries default the three fields to null when the hover layer harvested nothing', async () => {
    const containers = [document.getElementById('c1')];
    const records = await extractWithHoverRecords(
      containers,
      { content: { selector: '.a' } },
      { anchorSel: '.a' },
      async () => ({ hovered: true, htmlSnippet: '<div></div>' })
    );
    const hc = records[0].hovercards[0];
    assert.equal(hc.labelledbyText, null);
    assert.equal(hc.labelledbyAttr, null);
    assert.equal(hc.labelledbyNote, null);
  });

  it('a FAILED hover (popover_timeout) still carries the harvest — the label often needs no visible popover', async () => {
    // The core of the fix: a timestamp anchor whose tooltip never renders a
    // visible popover still has its full value in the hidden referenced
    // spans. The failure entry must carry it, not only success entries.
    const containers = [document.getElementById('c1')];
    const records = await extractWithHoverRecords(
      containers,
      { content: { selector: '.a' } },
      { anchorSel: '.a' },
      async () => ({ hovered: false, htmlSnippet: null, reason: 'popover_timeout', labelledbyText: 'June 21, 2024 at 3:15 PM', labelledbyAttr: 'aria-labelledby' })
    );
    const hc = records[0].hovercards[0];
    assert.equal(hc.reason, 'popover_timeout');
    assert.equal(hc.labelledbyText, 'June 21, 2024 at 3:15 PM');
  });

  it('hover_error entries keep the three fields null (no result object existed)', async () => {
    const containers = [document.getElementById('c1')];
    const records = await extractWithHoverRecords(
      containers,
      { content: { selector: '.a' } },
      { anchorSel: '.a' },
      async () => { throw new Error('ELEMENT_NOT_FOUND'); }
    );
    const hc = records[0].hovercards[0];
    assert.match(hc.reason, /hover_error/);
    assert.equal(hc.labelledbyText, null);
  });
});

describe('forty-second log: harvestAnchorLabel resolver (sliced from content-script.js)', () => {
  it('concatenates the referenced elements\' text — the hidden span carries the full timestamp', () => {
    const dom = setupDOM(
      '<span id="vis">June 21</span>' +
      '<span id="tip" style="display:none">June 21, 2024 at 3:15 PM</span>' +
      '<a id="anchor" aria-labelledby="vis tip">x</a>'
    );
    const fn = loadHarvestFn(dom);
    const out = fn(dom.window.document.getElementById('anchor'));
    assert.equal(out.text, 'June 21 June 21, 2024 at 3:15 PM');
    assert.equal(out.attr, 'aria-labelledby');
    assert.equal(out.note, null);
  });

  it('falls back to aria-describedby when labelledby resolves nothing', () => {
    const dom = setupDOM(
      '<span id="d1" hidden>Full description text</span>' +
      '<a id="anchor" aria-describedby="d1">x</a>'
    );
    const fn = loadHarvestFn(dom);
    const out = fn(dom.window.document.getElementById('anchor'));
    assert.equal(out.text, 'Full description text');
    assert.equal(out.attr, 'aria-describedby');
  });

  it('a present-but-unresolvable reference carries its falsification note', () => {
    const dom = setupDOM('<a id="anchor" aria-labelledby="gone1 gone2">x</a>');
    const fn = loadHarvestFn(dom);
    const out = fn(dom.window.document.getElementById('anchor'));
    assert.equal(out.text, '');
    assert.equal(out.attr, 'aria-labelledby');
    assert.match(out.note || '', /resolve to nothing/);
  });

  // Forty-fourth log: the no-attr quiet result used to be
  // {text:'', attr:null, note:null} — silent. On a cold verify tab that
  // silence was indistinguishable from "no label exists", so cold-tab
  // failures shipped with zero labelledbyNote receipts. The quiet path now
  // keeps the resolver's absent-attr note and the probed attr name.
  it('an anchor with no reference attribute returns the absent-attr falsification note', () => {
    const dom = setupDOM('<a id="anchor" href="/x">x</a>');
    const fn = loadHarvestFn(dom);
    const out = fn(dom.window.document.getElementById('anchor'));
    assert.equal(out.text, '');
    assert.equal(out.attr, 'aria-labelledby');
    assert.match(out.note || '', /absent/);
  });
});

describe('forty-second log: domHover wiring audits (content-script.js)', () => {
  it('harvests the anchor label BEFORE the dismiss — mouseout can unmount the referenced text', () => {
    const src = readSrc('content-script.js');
    const fnStart = src.indexOf('async function domHover(');
    assert.ok(fnStart > -1, 'domHover exists');
    const fnEnd = src.indexOf('\n  async function ', fnStart + 10);
    const body = src.slice(fnStart, fnEnd);
    const harvestIdx = body.indexOf('harvestAnchorLabel(anchor)');
    const dismissIdx = body.indexOf('TRUSTED_HOVER_DISMISS');
    assert.ok(harvestIdx > -1, 'domHover calls harvestAnchorLabel(anchor)');
    assert.ok(dismissIdx > -1, 'domHover dismiss block found');
    assert.ok(harvestIdx < dismissIdx, 'harvest runs before the dismiss — the 24th-log lesson (read text BEFORE mouseout unmounts it) applied to the anchor label');
  });

  it('attaches labelledbyText/labelledbyAttr on the result (note only when nothing resolved)', () => {
    const src = readSrc('content-script.js');
    const fnStart = src.indexOf('async function domHover(');
    const fnEnd = src.indexOf('\n  async function ', fnStart + 10);
    const body = src.slice(fnStart, fnEnd);
    assert.ok(/result\.labelledbyText\s*=/.test(body), 'result.labelledbyText assigned');
    assert.ok(/result\.labelledbyAttr\s*=/.test(body), 'result.labelledbyAttr assigned');
    assert.ok(/result\.labelledbyNote\s*=/.test(body), 'result.labelledbyNote assigned (falsification path)');
  });

  it('inline extractWithHoverRecords mirror forwards the three fields too (drift guard)', () => {
    const src = readSrc('content-script.js');
    const block = sliceFn(src, 'function extractWithHoverRecords(', '\n    function computeExtractListDiagnostics');
    assert.ok(/r && typeof r\.labelledbyText === 'string'/.test(block) || /labelledbyText:\s*\(r && r\.labelledbyText\)/.test(block),
      'inline mirror forwards labelledbyText');
    const pushes = block.split('hovercards.push(').length - 1;
    const mentions = block.split('labelledbyText').length - 1;
    assert.ok(pushes >= 2 && mentions >= 2, 'both entry shapes (success + catch) carry the fields');
  });
});
