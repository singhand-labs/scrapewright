// Sixth console.log survey (2026-09-01 12:39→13:33, three runs on the
// 2c863b0 build; ads-collection service: div[role='feed'] article:has(
// div[data-ad-...]) containers, hover the advertiser profile link).
//
// Infra stack all green: counter loops raw-grew to a plateau and exited
// (13→15→16→17→16 / 4→14 monotonic), no breaker, no deadlock; trusted wheel
// unlocked pages within its 3-attempt budget; one transient CDP
// wheel.mouseMoved 2s timeout 3.7s after a tab re-activation self-healed on
// the next scroll and its reason propagated into r2.stallReason; dismiss
// 27/27; RC49 invisible-wrapper descend + RC43 stability gates rejected
// efp overlay picks (area 340000/504608) across ticks and captured the real
// popover.
//
// The dominant failure: runs 1-2 used popoverSelector div[role='dialog']
// while the popover mounts as role='tooltip' — capture 2/10 then 3/10; the
// selector was only corrected by run 3 (7/7). Two compounding causes:
//
//   P1 evidence discarded at return time: auto-discovery SAW the real
//      popover on every failing anchor (ticks logged picked source:'added',
//      dist 216, area 166372) but failed hovers returned a bare
//      reason:'popover_timeout' — nothing in the result/autoFix prompt could
//      correct the selector, so the same wrong guess survived a second run.
//   P2 the guide steered the wrong guess: HOVER ENRICHMENT said a
//      popoverSelector like div[role="dialog"] is "usually correct" — role
//      varies by site and widget; the LLM had no in-result evidence path
//      out (and no rule that popover_timeout + anchorsFound ⇒ selector
//      mismatch ⇒ rewrite from observedPopover, never re-guess blind).
//
//   P3 observability: run 1 burned ~7.3s/anchor in UNLOGGED inter-anchor
//      time (dismiss-ok → next anchor's activation call) — 40% of the run's
//      wall time is unattributable (scrollIntoView-triggered virtualized
//      reflow vs deep popoverSel query on a 76K-px DOM cannot be
//      distinguished). Phase timings first, performance fixes only after
//      the next log attributes the time.

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const { extractWithHoverRecords } = require('../lib/list-extract-ops');

const CS_SRC = fs.readFileSync(path.join(__dirname, '..', 'content-script.js'), 'utf8');
const LIB_SRC = fs.readFileSync(path.join(__dirname, '..', 'lib', 'list-extract-ops.js'), 'utf8');
const WIZARD_UTILS_SRC = fs.readFileSync(path.join(__dirname, '..', 'lib', 'wizard-utils.js'), 'utf8');

function setupDOM(html) {
  const dom = new JSDOM(html, { url: 'https://example.com/page' });
  global.document = dom.window.document;
  global.window = dom.window;
  global.Node = dom.window.Node;
  return dom;
}

describe('P1: domHover keeps the observed candidate (source audit)', () => {
  const fnStart = CS_SRC.indexOf('async function domHover(');
  const fnBody = CS_SRC.slice(fnStart, fnStart + 40000);

  it('tracks the best scoring-cascade pick across auto-discover ticks', () => {
    assert.ok(/observedBest/.test(fnBody),
      'domHover must keep the best observed candidate across ticks');
    // Anchor on the TRACKING block (wonTicks increment), not the var
    // declaration earlier in the function.
    const trackIdx = fnBody.indexOf('observedBest.wonTicks');
    assert.ok(trackIdx > -1, 'the tracking block must exist');
    const trackChunk = fnBody.slice(trackIdx - 1500, trackIdx + 1500);
    assert.ok(/lastDwellMs/.test(trackChunk),
      'the observation must record when it was last seen');
    // 'added' beats a stale 'efp' observation: an element that just mounted
    // is the popover even when a positioned overlay was picked first.
    assert.ok(/'added'/.test(trackChunk),
      'an added-source pick must take precedence over an older efp observation');
  });

  it('attaches observedPopover to the FAILED result with structural identity', () => {
    assert.ok(/result\.observedPopover/.test(fnBody),
      'failed hovers must expose observedPopover');
    const asmIdx = fnBody.indexOf('result.observedPopover');
    const asmChunk = fnBody.slice(asmIdx - 900, asmIdx + 1400);
    assert.ok(/!htmlSnippet/.test(asmChunk),
      'the failure branch keeps its !htmlSnippet guard (no capture = failure evidence)');
    // The identity fields live in the shared popoverIdentityOf helper —
    // audit it directly so the success and failure branches can never
    // drift apart (RC8/RC35 inline-drift family).
    const helperIdx = CS_SRC.indexOf('function popoverIdentityOf(');
    assert.ok(helperIdx > -1, 'popoverIdentityOf helper exists');
    const helper = CS_SRC.slice(helperIdx, helperIdx + 2600);
    for (const field of ['role', 'ariaLabel', 'classHead', 'getAttribute']) {
      assert.ok(new RegExp(field).test(helper),
        'observedPopover summary must include ' + field);
    }
    assert.ok(/\.slice\(0, 120\)/.test(helper),
      'classHead must be capped (context-diet discipline)');
  });

  // Thirty-sixth log: observedPopover used to ride ONLY failures, so the
  // natural harvest gate `h.observedPopover && h.htmlSnippet` ("a popover
  // was observed AND captured") was structurally impossible — whole
  // sessions shipped hovercards:[] with the hover layer working end to end.
  it('attaches observedPopover to SUCCESSFUL captures too (the harvest gate must be satisfiable)', () => {
    const asmIdx = fnBody.indexOf('result.observedPopover');
    const asmChunk = fnBody.slice(asmIdx - 900, asmIdx + 1400);
    assert.ok(/capturedEl/.test(asmChunk),
      'the success branch keys off the element htmlSnippet was captured from');
    assert.ok(/popoverIdentityOf\(capturedEl/.test(asmChunk),
      'success identity goes through the same shared helper');
    const capA = fnBody.indexOf('matchedSel = popoverSel;');
    assert.ok(/capturedEl = popEl/.test(fnBody.slice(capA, capA + 200)),
      'path (a) explicit-selector captures record their element');
    const capB = fnBody.indexOf("matchedSel = '[auto-discovered popover]';");
    assert.ok(/capturedEl = bestEl/.test(fnBody.slice(capB, capB + 200)),
      'path (b) auto-discovered captures record their element');
  });
});

describe('P1: extractWithHoverRecords carries observedPopover on failed entries', () => {
  beforeEach(() => {
    setupDOM('<!DOCTYPE html><html><body></body></html>');
  });

  const fieldMap = { title: 'h3.title' };
  const hoverCfg = { anchorSel: 'a.profile-link', popoverSel: 'div[role="dialog"]' };

  function oneContainer() {
    document.body.innerHTML = `
      <div class="item">
        <h3 class="title">A</h3>
        <a class="profile-link" href="/u/1">Sponsor</a>
      </div>`;
  }

  it('copies observedPopover from a failed hover onto the hovercard entry', async () => {
    oneContainer();
    const observed = {
      tag: 'DIV', role: 'tooltip', ariaLabel: 'Sponsor profile',
      id: '', classHead: 'x1n2 x2s7', source: 'added',
      posAbsolute: false, z: 0, dist: 216, area: 166372,
      wonTicks: 3, lastSeenDwellMs: 1863
    };
    const records = await extractWithHoverRecords(
      Array.from(document.querySelectorAll('.item')),
      fieldMap,
      hoverCfg,
      async () => ({
        hovered: false, htmlSnippet: null, popoverSelector: null,
        autoDiscovered: false, reason: 'popover_timeout',
        observedPopover: observed
      }),
      { allowEmpty: true }
    );
    const card = records[0].hovercards[0];
    assert.equal(card.hovered, false);
    assert.equal(card.reason, 'popover_timeout');
    assert.deepEqual(card.observedPopover, observed,
      'the failed entry must carry the observed popover identity verbatim');
  });

  it('forwards observedPopover from a SUCCESSFUL hover too (thirty-sixth log: the harvest gate must see captures)', async () => {
    oneContainer();
    const observed = {
      tag: 'DIV', role: 'tooltip', ariaLabel: 'Sponsor profile',
      id: '', classHead: 'x1n2 x2s7', source: 'added',
      posAbsolute: false, z: 0, dist: 216, area: 166372,
      wonTicks: 3, lastSeenDwellMs: 1863
    };
    const records = await extractWithHoverRecords(
      Array.from(document.querySelectorAll('.item')),
      fieldMap,
      hoverCfg,
      async () => ({
        hovered: true, htmlSnippet: '<div role="tooltip">card</div>',
        popoverSelector: 'div[role="tooltip"]', autoDiscovered: true,
        observedPopover: observed
      }),
      { allowEmpty: true }
    );
    const card = records[0].hovercards[0];
    assert.equal(card.hovered, true);
    assert.deepEqual(card.observedPopover, observed,
      'a success entry carries the captured popover identity — `observedPopover && htmlSnippet` gates must be satisfiable');
  });

  it('still serializes absent observations as null on success (hover fn returned no identity)', async () => {
    oneContainer();
    const records = await extractWithHoverRecords(
      Array.from(document.querySelectorAll('.item')),
      fieldMap,
      hoverCfg,
      async () => ({
        hovered: true, htmlSnippet: '<div role="tooltip">card</div>',
        autoDiscovered: true
      }),
      { allowEmpty: true }
    );
    const card = records[0].hovercards[0];
    assert.equal(card.observedPopover, null,
      'absence of identity must serialize as null, not undefined/throw');
  });

  it('tolerates a failed hover with no observation (popover never mounted)', async () => {
    oneContainer();
    const records = await extractWithHoverRecords(
      Array.from(document.querySelectorAll('.item')),
      fieldMap,
      hoverCfg,
      async () => ({
        hovered: false, htmlSnippet: null, reason: 'no_hover_signal_early_exit'
      }),
      { allowEmpty: true }
    );
    const card = records[0].hovercards[0];
    assert.equal(card.observedPopover, null,
      'absence of observation must serialize as null, not undefined/throw');
  });

  it('source audit: the entry assembly copies observedPopover on success and failure alike (lib mirror)', () => {
    const i = LIB_SRC.indexOf('observedPopover: (r && r.observedPopover) || null');
    assert.ok(i > -1, 'the lib entry forwards observedPopover without gating on !hovered');
    assert.ok(!/!r\.hovered && r\.observedPopover/.test(LIB_SRC),
      'the failure-only strip must be gone from the lib (thirty-sixth log)');
    const chunk = LIB_SRC.slice(i - 700, i + 700);
    assert.ok(/anchorHref/.test(chunk),
      'the propagation lives in the hovercards entry assembly');
    const csIdx = CS_SRC.indexOf('observedPopover: (r && r.observedPopover) || null');
    assert.ok(csIdx > -1, 'the content-script inline mirror forwards it identically');
  });
});

describe('P2: HOVER ENRICHMENT teaches evidence-based popoverSelector repair', () => {
  const idx = WIZARD_UTILS_SRC.indexOf('HOVER ENRICHMENT (hovercard');
  const chunk = WIZARD_UTILS_SRC.slice(idx, idx + 12000);

  it('has a POPOVER SELECTOR rule keyed to the popover_timeout signal', () => {
    const ruleIdx = chunk.indexOf('POPOVER SELECTOR FROM EVIDENCE');
    assert.ok(ruleIdx > -1,
      'the rule must exist by name inside HOVER ENRICHMENT');
    const rule = chunk.slice(ruleIdx, ruleIdx + 2600);
    assert.ok(/popover_timeout/.test(rule));
    assert.ok(/observedPopover/.test(rule),
      'must point the LLM at the observedPopover field on failed entries');
    assert.ok(/autoDiscovered/.test(rule),
      'autoDiscovered:true captures must be called out as a wrong selector');
  });

  it('teaches the two failure shapes (mounted-but-missed vs never-mounted)', () => {
    const ruleIdx = chunk.indexOf('POPOVER SELECTOR FROM EVIDENCE');
    const rule = chunk.slice(ruleIdx, ruleIdx + 2600);
    assert.ok(/no_hover_signal_early_exit/.test(rule),
      'the no-signal early-exit shape must be contrasted (anchor has no popover)');
  });

  it('no longer claims one role is "usually correct"', () => {
    assert.ok(!/usually correct/.test(chunk),
      'role hard-coding steered the wrong dialog guess in the sixth log; roles vary by site');
  });
});

describe('P3: hover_anchor_timing phase diagnostics (source audit)', () => {
  const fnStart = CS_SRC.indexOf('async function domHover(');
  // Thirty-first log: the budget-disclosure additions to domHover's
  // popover_timeout branch pushed the notify past the old 40000 window —
  // the window is a scoping heuristic, not a size contract.
  const fnBody = CS_SRC.slice(fnStart, fnStart + 42000);

  it('emits hover_anchor_timing with per-phase durations', () => {
    const i = fnBody.indexOf('hover_anchor_timing');
    assert.ok(i > -1, 'domHover must notify hover_anchor_timing');
    const chunk = fnBody.slice(i, i + 800);
    for (const phase of ['scrollMs', 'dispatchMs', 'dwellMs', 'dismissMs']) {
      assert.ok(new RegExp(phase).test(chunk),
        'phase timing must include ' + phase);
    }
  });
});

describe('universality: sixth-log rule additions carry no site tokens', () => {
  const FORBIDDEN = /facebook|twitter|linkedin|tiktok|reddit|\bfb\b/i;
  it('HOVER ENRICHMENT chunk', () => {
    const idx = WIZARD_UTILS_SRC.indexOf('HOVER ENRICHMENT (hovercard');
    assert.ok(!FORBIDDEN.test(WIZARD_UTILS_SRC.slice(idx, idx + 12000)));
  });
});
