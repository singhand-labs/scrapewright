// Twenty-third log RC-C: the stopped event carries the honest-ship
// disclosure ("[VERIFY PARTIAL-EMPTY — confirmed field(s) empty in every
// record: ...]") built by the finish path, but wizard.js's generic event
// mirror JSON.stringify(ev).slice(0, 200) cut it mid-list in BOTH the
// twenty-second and twenty-third logs — the export showed "shipped
// (artifact v10, contract confirmed)" and nothing about the holes.
// Source-text audit like rc52-wizard-maxtokens-parity.test.js.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'wizard.js'), 'utf8');

describe('wizard.js session-event console mirror budgets (RC-C)', () => {
  it('the generic event mirror gives detail-bearing events ≥600 chars, not 200', () => {
    const m = /console\.log\('\[session\]', ev\.type, JSON\.stringify\(ev\)\.slice\(0, (\d+)\)\)/.exec(SRC);
    assert.ok(m, 'generic event mirror line exists in wizard.js');
    const cap = parseInt(m[1], 10);
    assert.ok(cap >= 600,
      'generic mirror cap is ' + cap + ' — the stopped event detail (honest-ship disclosure: PARTIAL-EMPTY / LAST VERIFY FAILED annotations plus the field list) needs at least the 600-char budget the tool_result mirror already uses');
  });
});
