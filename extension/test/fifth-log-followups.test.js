// Fifth console.log survey (2026-09-01, sessions 2026-08-31 17:07 →
// 2026-09-01 04:40). The zero-trap stack from the fourth log verified in
// production first (breaker fired a TRUE positive at 17:08 — feed container
// matched, articles 0 for 8 iterations, viewport-gated lazy render; autoFix
// answered with the taught RAW fallback counter; the deadlock-free
// stalled>=5 exhausted exit fired next run). Three remaining script-quality
// failure classes are pinned here as guide rules, plus one breaker fix:
//
//   P1 cursor-gated completion (step 4): 'cursor = start + records.length'
//      gated done against the post-count target — records.length counts
//      CONTAINERS, so recommendation cards consumed slots: done at cursor
//      10 == 12 containers == 7 real posts (user feedback 'Less than 10
//      posts', 04:39 ACK nailed it).
//   P2 premature exhausted while raw grows (step 2): 02:06:54 iteration
//      shows rawCount 14→15 (page STILL loading) yet noGrowth incremented
//      to 3 because the filtered postLike count didn't move; exited
//      exhausted at postLike=9 below the target of 10.
//   P3 label-only ad filter: the 02:11 output's posts[0] is a sponsored ad
//      that passed '/aria-label="[^"]*Sponsored/i' — while its postId,
//      postingTime and hovercards are ALL empty because ads structurally
//      lack the permalink/timestamp/hover anchors. Structural absence is
//      the reliable signal; label text is locale/markup-fragile.
//   P4 breaker time-blindness: the threshold is 8 ITERATIONS, but this one
//      log contains both 2s-cadence wait steps (17:08) and 17s-cadence
//      scroll steps (fourth log). At 2s cadence the breaker fires at 16s
//      and tells autoFix 'your counting filter is broken' — a wrong
//      diagnosis for a page that simply renders slowly. Fix: the streak
//      must ALSO span FROZEN_ZERO_MIN_ELAPSED_MS; short-cadence steps fall
//      through to natural POLL_EXHAUSTED where the post-hoc detector
//      relabels with the same guidance.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { FROZEN_ZERO_MIN_ELAPSED_MS } = require('../lib/wizard-utils');

const WIZARD_UTILS_SRC = fs.readFileSync(path.join(__dirname, '..', 'lib', 'wizard-utils.js'), 'utf8');
const WIZARD_SRC = fs.readFileSync(path.join(__dirname, '..', 'wizard.js'), 'utf8');

describe('CARD-TYPE HETEROGENEITY: cursor + positive-evidence corollaries', () => {
  const idx = WIZARD_UTILS_SRC.indexOf('CARD-TYPE HETEROGENEITY');
  const chunk = WIZARD_UTILS_SRC.slice(idx, idx + 6000);

  it('(d) a container cursor is not a record count — gate done on filtered records', () => {
    assert.ok(/cursor over containers is not a count of records/.test(chunk),
      'the cursor corollary must be taught');
    assert.ok(/never on the raw container cursor/.test(chunk));
    assert.ok(/consume cursor slots/.test(chunk),
      'must name the failure mode: rec cards consume slots and starve the target');
  });

  it('(e) positive structural evidence beats negative label matching', () => {
    assert.ok(/positive structural evidence/.test(chunk));
    assert.ok(/lacks? EVERY organic anchor/.test(chunk),
      'the structural-absence test must be taught (ads lack permalink/timestamp/hover anchors)');
    assert.ok(/locale- and markup-fragile/.test(chunk));
  });
});

describe('ZERO-TRAP COUNTER: raw growth resets the stall counter', () => {
  // Anchor on the rule DEFINITION — CARD-TYPE corollary (c) cross-references
  // 'see ZERO-TRAP COUNTER' ~3K chars earlier in the file.
  const idx = WIZARD_UTILS_SRC.indexOf('ZERO-TRAP COUNTER (filtered counting');
  const chunk = WIZARD_UTILS_SRC.slice(idx, idx + 6000);

  it('defense (c) teaches that raw growth is progress', () => {
    assert.ok(/raw count grows/i.test(chunk),
      'the 02:06:54 evidence (rawCount 14→15 while noGrowth→3, exit below target) must be guarded');
    assert.ok(/reset your noGrowth\/stalled counter/i.test(chunk));
    assert.ok(/has not exhausted/.test(chunk));
  });
});

describe('breaker elapsed-time floor (P4)', () => {
  it('FROZEN_ZERO_MIN_ELAPSED_MS is exported and >= 60s', () => {
    assert.ok(typeof FROZEN_ZERO_MIN_ELAPSED_MS === 'number');
    assert.ok(FROZEN_ZERO_MIN_ELAPSED_MS >= 60000,
      'the floor must span a genuinely slow render; got ' + FROZEN_ZERO_MIN_ELAPSED_MS);
  });

  it('wizard breaker requires streak AND elapsed (source wiring)', () => {
    assert.ok(/FROZEN_ZERO_MIN_ELAPSED_MS/.test(WIZARD_SRC),
      'wizard.js breaker must consult the elapsed floor');
    const i = WIZARD_SRC.indexOf('FROZEN_ZERO_STREAK_THRESHOLD &&');
    assert.ok(i > 0);
    const cond = WIZARD_SRC.slice(i, i + 300);
    assert.ok(/Date\.now\(\)/.test(cond),
      'the fire condition must include an elapsed check, not iteration count alone: ' + cond);
  });

  it('streak state carries a since timestamp (per-streak start)', () => {
    assert.ok(/since/.test(WIZARD_SRC.slice(
      WIZARD_SRC.indexOf('zeroCounterStreaks.get'),
      WIZARD_SRC.indexOf('zeroCounterStreaks.get') + 600)),
      'the streak entry must record when it started');
  });
});

describe('universality: fifth-log rule additions carry no site tokens', () => {
  const FORBIDDEN = /facebook|twitter|linkedin|tiktok|reddit|\bfb\b/i;
  it('CARD-TYPE chunk', () => {
    const idx = WIZARD_UTILS_SRC.indexOf('CARD-TYPE HETEROGENEITY');
    assert.ok(!FORBIDDEN.test(WIZARD_UTILS_SRC.slice(idx, idx + 6000)));
  });
  it('ZERO-TRAP chunk', () => {
    const idx = WIZARD_UTILS_SRC.indexOf('ZERO-TRAP COUNTER (filtered counting');
    assert.ok(!FORBIDDEN.test(WIZARD_UTILS_SRC.slice(idx, idx + 6000)));
  });
});
