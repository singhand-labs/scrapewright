// Code-review P2 #14: twins constants parity — the timestamp twins
// (domTimestamp in content-script.js vs probe.timestamp in probe-tools.js)
// and the date-shape regexes (TS_SHAPE_RES / TS_DATE_SUBSTRING_RES in
// content-script vs wizard-utils' DATE_SUBSTRING_RES family) must stay
// textually identical (normalized whitespace), or the two halves of the
// timestamp dance silently disagree about what counts as a date.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const CS = fs.readFileSync(path.join(__dirname, '..', 'content-script.js'), 'utf8');
const WU = fs.readFileSync(path.join(__dirname, '..', 'lib/wizard-utils.js'), 'utf8');
const PT = fs.readFileSync(path.join(__dirname, '..', 'lib/probe-tools.js'), 'utf8');

function sliceArrayLiteral(src, name) {
  const i = src.indexOf('var ' + name + ' = [') !== -1 ? src.indexOf('var ' + name + ' = [') : src.indexOf(name + ' = [');
  assert.ok(i > -1, 'array literal ' + name + ' found');
  const start = src.indexOf('[', i);
  const end = src.indexOf('];', start);
  assert.ok(end > start);
  return src.slice(start + 1, end);
}
// Extract the /.../flags regex sources from an array literal's text.
function regexSources(literalText) {
  const out = [];
  const re = /\/((?:[^/\\\n]|\\.)+)\/([gimsuy]*)/g;
  let m;
  while ((m = re.exec(literalText)) !== null) out.push(m[1] + '|' + m[2]);
  return out;
}
function norm(s) { return s.replace(/\s+/g, ''); }

describe('#14 twins constants parity', () => {
  it('TS_DATE_SUBSTRING_RES (content-script) equals wizard-utils DATE_SUBSTRING_RES, pattern for pattern', () => {
    const cs = regexSources(sliceArrayLiteral(CS, 'TS_DATE_SUBSTRING_RES'));
    const wu = regexSources(sliceArrayLiteral(WU, 'DATE_SUBSTRING_RES'));
    assert.ok(cs.length > 0 && wu.length > 0);
    assert.deepEqual(cs, wu, 'date-substring regex sources identical (order included)');
  });
  it('domTimestamp default anchorSel equals probe.timestamp default anchorSel', () => {
    const def = 'a:has(span[aria-labelledby]), [aria-labelledby], abbr[aria-label], time';
    const csIdx = CS.indexOf("var TS_MAX_HOVER_ANCHORS");
    assert.ok(CS.slice(csIdx, csIdx + 4000).includes(def), 'domTimestamp default anchor union present');
    // Ninety-ninth round: both sides now hold the union in a constant and
    // UNION custom anchorSels with it — assert the constant carries the
    // identical union on both sides.
    const ptIdx = PT.indexOf('DEFAULT_TS_ANCHORS =');
    assert.ok(ptIdx !== -1, 'probe.timestamp default union constant exists');
    assert.ok(PT.slice(ptIdx, ptIdx + 400).includes(def), 'probe.timestamp default anchor union present');
  });
});
