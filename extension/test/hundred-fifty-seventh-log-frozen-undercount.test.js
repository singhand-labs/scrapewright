// extension/test/hundred-fifty-seventh-log-frozen-undercount.test.js
//
// 157th log: the session died on maxTurns (80/80) with the last verify
// RED — POLL_EXHAUSTED on the collect step: the count froze at 4 for a
// trailing 5-streak across 17 iterations (receipt fully evidenced:
// counter trace, pacing 20 attempts over 31345ms avg 1650ms — a SETTLED
// loop, SCROLL_COUNT_FROZEN fired with frozenCount:4 grewFrom:3). The
// model then spent its own snippet round discovering the cause: the
// container selector carried a trailing :has(link-union) clause — the
// STRICT selector counted 6 on the research tab while the stripped base
// (loose) counted 9; on the verify tab the strict count froze at 4. The
// target (count input) was unreachable UNDER THE SELECTOR, not under the
// supply.
//
// The harness machinery all worked (evidence-rich receipt, frozen
// detector, snippet gate forcing the dry-run that produced the
// divergence measurement) — but the knowledge unit teaching was WRONG:
// scroll-count-frozen branches (0) no-settle, (1) renderer gating,
// (2) genuine exhaustion, (3) cold-tab divergence, and asserts "a frozen
// count says nothing about selectors (the same selectors matched N items
// fine)". This round falsified that claim: a strict selector with
// trailing :has/:not clauses can freeze BELOW the real population — the
// fourth cause, with a one-snippet differential discriminator (count the
// selector vs its stripped base).
//
// Fix under test: branch (4) SELECTOR UNDERCOUNT added; the absolute
// "says nothing about selectors" claim corrected; origin carries the
// 157th counterexample.
const { test, describe, it } = require('node:test');
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const KU = fs.readFileSync(path.join(__dirname, '..', 'lib', 'knowledge-units.js'), 'utf8');

describe('157th log — frozen-count branch (4): selector undercount', () => {
  const i = KU.indexOf("id: 'scroll-count-frozen'");
  const body = KU.slice(i, KU.indexOf("id: 'duplicate-id-fallback'", i));

  it('the unit exists', () => {
    assert.ok(i > -1, 'scroll-count-frozen unit found');
  });

  it('names the SELECTOR UNDERCOUNT branch with its discriminator', () => {
    assert.match(body, /SELECTOR UNDERCOUNT/i, 'branch (4) exists');
    assert.match(body, /stripped base/i, 'the differential instruction names the stripped base');
    assert.match(body, /counts HIGHER|counts higher/i, 'the discriminating outcome is spelled out');
    assert.match(body, /:has/i, 'the trailing-clause family is named');
  });

  it('the falsified absolute claim is corrected (a strict selector CAN freeze below the population)', () => {
    assert.doesNotMatch(body, /a frozen count says nothing about selectors \(the same selectors matched N items fine\)/,
      'the 49th-round absolute claim died on the 157th counterexample');
    assert.match(body, /freeze BELOW|below the (real|available) population|undercount/i,
      'the corrected claim names the undercount shape');
  });

  it('the origin line carries the 157th counterexample', () => {
    assert.match(body, /157th/, 'origin updated with the falsifying incident');
  });

  it('the earlier branches survive (no-settle / gating / exhaustion / cold-tab)', () => {
    for (const token of ['NO SETTLE', 'RENDERER GATING', 'GENUINE EXHAUSTION', 'COLD-TAB DIVERGENCE']) {
      assert.ok(body.indexOf(token) > -1, 'branch ' + token + ' intact');
    }
  });
});
