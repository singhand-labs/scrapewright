// Ninetieth-round main line (user directive, third time: "FB 这个案例中，
// 时间悬浮提示弹窗一定有完整日期，从中提取"). Full-log chain audit:
// the FB timestamp tooltip is a PRE-MOUNTED strip that becomes VISIBLE on
// hover (efp-source at T1, absent from the T0 baseline → passes RC43) and
// is then rejected by the 50×50 `too_small` gate — its text never lands in
// rejectedAddedTexts because rememberRejectedAdded only collects
// source==='added' nodes. The full date the user says is ALWAYS there was
// collected by NOTHING: the artifact read labelledbyText (the visible
// month-day label), $timestamp/probe.timestamp candidates came back
// labelledby-only, and even when 3 popovers were captured the receipt that
// showed their content was dropped by the mirrorLines/Infinity regression
// (fixed in 0e28714).
//
// Fixes under test:
//   F2a — the too_small reject branch collects text from ANY non-baseline
//         visible candidate (an efp-source node absent from the T0 baseline
//         BECAME VISIBLE during the dwell — that is popover-defining
//         behavior; a narrow strip is a tooltip, not noise);
//   F2b — $timestamp/probe.timestamp add rejectedAddedTexts as a candidate
//         source (labelledby/aria/text/hover-mounted included rejected
//         strips);
//   F2c — $extractWithHover hovercards entries carry rejectedAddedTexts so
//         the model sees the tooltip text it can bind via read:hoverPopover
//         even when the visual picker never blessed the strip;
//   F2d — verify's unusedCaptures census NAMES a captured full-absolute
//         date sample (the "bind it NOW" callout).
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const CS_SRC = fs.readFileSync(path.join(__dirname, '..', 'content-script.js'), 'utf8');
const LEO_SRC = fs.readFileSync(path.join(__dirname, '..', 'lib', 'list-extract-ops.js'), 'utf8');
const PT_SRC = fs.readFileSync(path.join(__dirname, '..', 'lib', 'probe-tools.js'), 'utf8');
const VR_SRC = fs.readFileSync(path.join(__dirname, '..', 'lib', 'verify-runner.js'), 'utf8');

describe('90th-round F2a: too_small rejects of became-visible strips are text-collected', () => {
  it('the too_small branch remembers candidates regardless of source (baseline chrome was already rejected by RC43)', () => {
    const i = CS_SRC.indexOf("reason: 'too_small'");
    assert.ok(i !== -1);
    const block = CS_SRC.slice(i - 420, i + 60);
    assert.match(block, /rememberRejected(VisibleStrip|Candidate)\(|rememberRejectedAdded\(node,\s*true\)/,
      'the too_small branch uses the widened collector — an efp-source strip absent from the T0 baseline became visible during the dwell');
  });

  it('the widened collector exists and bypasses the added-only gate', () => {
    assert.match(CS_SRC, /function rememberRejectedVisibleStrip\(|function rememberRejectedAdded\(node, (opts|widen)/,
      'a widened collector function/param exists');
    const hi = CS_SRC.indexOf('function rememberRejectedAdded(');
    assert.ok(hi !== -1, 'helper found');
    assert.match(CS_SRC.slice(hi, hi + 700), /widen|visibleStrip/, 'the gate has a widened path');
    // pre_existed_unchanged rejects stay gated (chrome noise stays out)
    const rc43 = CS_SRC.indexOf("reason: 'pre_existed_unchanged'");
    const rcBlock = CS_SRC.slice(rc43 - 300, rc43 + 40);
    assert.ok(!/rememberRejectedVisibleStrip|rememberRejectedAdded\(node,\s*true\)/.test(rcBlock),
      'baseline chrome rejects do NOT widen');
  });
});

describe('90th-round F2b: $timestamp + probe.timestamp take candidates from rejectedAddedTexts', () => {
  it('domTimestamp harvests hv.rejectedAddedTexts into the candidate pool', () => {
    const ts = CS_SRC.slice(CS_SRC.indexOf('async function domTimestamp('), CS_SRC.indexOf('async function domExists('));
    assert.match(ts, /rejectedAddedTexts/, 'the $timestamp harvest reads rejectedAddedTexts');
    assert.match(ts, /for \(const sub of extractDateSubstringsCS\(str\)\)/, 'texts flow into candidates (date-substring extraction)');
  });

  it('probe.timestamp harvests hovercards[].rejectedAddedTexts too', () => {
    assert.match(PT_SRC.slice(PT_SRC.indexOf('async function timestamp(')), /rejectedAddedTexts/);
  });
});

describe('90th-round F2c: $extractWithHover hovercards carry the rejected strips', () => {
  it('list-extract-ops hovercards entries include rejectedAddedTexts from the hover result', () => {
    assert.match(LEO_SRC, /rejectedAddedTexts/, 'the records layer forwards the field');
  });
  it('content-script inline mirror kept in sync', () => {
    const inline = CS_SRC.slice(CS_SRC.indexOf('function createInlineListExtractOps'), CS_SRC.indexOf('function domHover'));
    assert.match(inline, /rejectedAddedTexts/, 'inline fallback forwards the field too');
  });
});

describe('90th-round F2d: unusedCaptures census NAMES a captured full-absolute date', () => {
  it('verify-runner scans unusedCaptures samples for a full absolute date and calls it out', () => {
    const i = VR_SRC.indexOf('const computeUnusedCaptures = () => {');
    assert.ok(i !== -1, 'computeUnusedCaptures found');
    const block = VR_SRC.slice(i, i + 4200);
    assert.match(block, /FULL ABSOLUTE DATE|full absolute date/i, 'the callout exists');
    assert.match(block, /read:'hoverPopover'|read:\\'hoverPopover\\'/, 'the callout names the bind route');
  });
});

// Ninety-third-round: the model shipped hoverCards:[] while 18 captured
// author/group cards sat unused — it read the requirement's "exclude
// recommendation modules" as excluding the captured cards themselves. The
// census note must name the distinction generically.
describe('93rd-round: unusedCaptures note distinguishes enrichment cards from feed modules', () => {
  it('the non-consuming note teaches: captured hovercards ARE the enrichment the contract asks for; the exclusion rule targets non-post modules', () => {
    const i = VR_SRC.indexOf("hover popovers were CAPTURED this run but no fieldMap field consumes them");
    assert.ok(i !== -1, 'note found');
    const note = VR_SRC.slice(i, i + 700);
    assert.match(note, /enrichment/i, 'the note names the enrichment role of captured cards');
    assert.match(note, /exclusion|exclude/i, 'the note names the exclusion distinction');
  });
});
