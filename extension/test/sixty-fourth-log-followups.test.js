// Sixty-fourth log (2026-09-11 15:25 export, wizard.html/service_worker/
// offscreen console logs, session rs-1789110083487-1, glm-5.3, FB search).
// The session COMPLETED: io.confirm → 6× service.update → 4× verify.run →
// finish at 59/60 with an honest disclosure ladder (postTime relative-only,
// likeCount unbound, comment/share anti-scrambled, location page-lacks).
// The 63rd-round fixes validated live: anchor_not_hoverable fired 9× with
// zero (400,400) dispatches and zero wasted dwell; the grounding gates
// rejected two un-evidenced artifacts (attr-distribution, observation);
// POLL_EXHAUSTED carried the pacing diagnostic and was fixed by v2.
//
// The dominant remaining defect was in probe.timestamp itself — the
// one-call tool built (56th log) for exactly this session's timestamp wall:
//
//   (a) POPOVER BLINDNESS — the candidate harvest read only anchor
//       labelledby/aria-label/text and hovercard labelledbyText/anchorText.
//       The absolute timestamp lives in the hover-mounted TOOLTIP's own
//       text (div[role=tooltip] htmlSnippet — the model's MANUAL probe.hover
//       captured "Friday, September 11, 2026 at 1:43 AM" from exactly
//       there), but the tool never read popover text. All three calls
//       returned blind negatives, and the model quoted them into the
//       finish's environmental claim "the timestamp hovercard never renders
//       a full-date popover" — contradicted by its own earlier capture.
//   (b) MASQUERADE IN THE ABSOLUTE SLOT — the first and third calls
//       returned "Ng6cOb30.comCatThis week mathematicians used AI to solve
//       the first Millennium Prize Problem in 20 years—the field's gr…" as
//       .absolute: the whole-string looksLikeDate predicate passed the
//       prose via \b\d+\s*years\b ("in 20 years") and REL found no "ago",
//       so duration-mentioning PROSE classified as an absolute date (the
//       33rd-log masquerade class, inside the tool itself).
//
// Fixes under test: extractDateSubstrings (calendar-generic substring
// extraction, fragment-containment dedupe, CJK relative requires 前) +
// probe.timestamp pushValue gates values at 60 chars (short → whole-value
// looksLikeDate as before; long → substring extraction only) and harvests
// the captured popover's text as source 'hover.popoverText'; the
// no-candidates note now scopes its negative to "the anchors THIS call
// hovered" instead of asserting the page exposes no timestamp.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { extractDateSubstrings } = require('../lib/wizard-utils');
const { createProbeTools } = require('../lib/probe-tools');

// Verbatim from the log (wizard.html.console.log line 1062 — the absolute
// slot of probe.timestamp call #1).
const MASQUERADE = 'Ng6cOb30.comCatThis week mathematicians used AI to solve the first “Millennium Prize Problem” in 20 years—the field’s gr';
// Verbatim from the model's manual hover capture (think at line 1257).
const TOOLTIP_SNIPPET = '<div role="tooltip"><div>Shared with Public</div><div>Friday, September 11, 2026 at 1:43 AM</div></div>';

describe('sixty-fourth log: extractDateSubstrings', () => {
  it('extracts the absolute date from a hover-mounted tooltip snippet (the capture the tool was blind to)', () => {
    const out = extractDateSubstrings(TOOLTIP_SNIPPET);
    assert.ok(out.includes('September 11, 2026 at 1:43 AM'),
      'the tooltip text yields the full absolute date: ' + JSON.stringify(out));
  });

  it('the duration-mentioning masquerade yields NOTHING (not a fragment, not a relative)', () => {
    assert.deepEqual(extractDateSubstrings(MASQUERADE), [],
      '"in 20 years" prose must not produce any date candidate');
    assert.deepEqual(extractDateSubstrings('solve the first Millennium Prize Problem in 20 years'), []);
  });

  it('calendar-generic shapes: ISO, slash, CJK absolute, en+CJK relative', () => {
    assert.deepEqual(extractDateSubstrings('Posted 2024-03-05 14:30 via API'), ['2024-03-05 14:30']);
    assert.deepEqual(extractDateSubstrings('due 3/9/2026 2:30 PM'), ['3/9/2026 2:30 PM']);
    assert.deepEqual(extractDateSubstrings('发布于 2026年6月25日 10:30'), ['2026年6月25日 10:30']);
    assert.deepEqual(extractDateSubstrings('4 hours ago and 3天前'), ['4 hours ago', '3天前']);
  });

  it('fragments contained in a fuller candidate are dropped (the CJK fragment class)', () => {
    assert.deepEqual(extractDateSubstrings('发布于 2026年6月25日'), ['2026年6月25日'],
      'no separate "2026年"/"6月"/"25日" fragment candidates');
  });

  it('count-shaped prose is not a date', () => {
    assert.deepEqual(extractDateSubstrings('Like: 179 people · 12 comments · 3 shares'), []);
  });
});

// ---------------------------------------------------------------------------
// probe.timestamp behavioral — the createProbeTools harness from the
// fifty-sixth-log tests (executeDsl stub returning the record the composed
// $extractWithHover snippet would produce).
// ---------------------------------------------------------------------------

function makeTools(impl) {
  return createProbeTools({ executeDsl: async () => impl() });
}

describe('sixty-fourth log: probe.timestamp popover harvest + masquerade gate', () => {
  it('tooltip htmlSnippet becomes the ABSOLUTE via hover.popoverText; anchorText masquerade contributes nothing', async () => {
    const tools = makeTools(() => [{
      __t_label: '13 hours ago',
      __t_aria: '',
      __t_text: '13 hours ago',
      hovercards: [
        {
          labelledbyText: '13 hours ago',
          anchorText: MASQUERADE,
          htmlSnippet: TOOLTIP_SNIPPET
        }
      ]
    }]);
    const r = await tools.timestamp({ containerSel: 'div.card', index: 1 });
    assert.ok(!r.error, 'no error: ' + JSON.stringify(r));
    assert.equal(r.absolute, 'September 11, 2026 at 1:43 AM',
      'the popover text wins — the source the 64th session needed');
    assert.equal(r.absoluteSource, 'hover.popoverText');
    assert.equal(r.relative, '13 hours ago');
    for (const c of r.candidates) {
      assert.ok(!/Millennium|Ng6cOb30/.test(c.value),
        'the masquerade must not appear in any candidate: ' + JSON.stringify(c));
    }
  });

  it('the EXACT 64th-log record shape no longer produces a garbage absolute', async () => {
    const tools = makeTools(() => [{
      __t_label: '13 hours ago',
      __t_aria: '',
      __t_text: '',
      hovercards: [
        { labelledbyText: '13 hours ago', anchorText: MASQUERADE },
        { labelledbyText: '13 hours ago', anchorText: MASQUERADE },
        { labelledbyText: '13 hours ago', anchorText: MASQUERADE }
      ]
    }]);
    const r = await tools.timestamp({ containerSel: 'div.card', index: 1 });
    assert.equal(r.absolute, null, 'no popover, no masquerade → no absolute');
    assert.equal(r.relative, '13 hours ago');
    assert.ok(r.candidates.every((c) => c.relative), 'only relative ages remain: ' + JSON.stringify(r.candidates));
    assert.match(r.note, /absolute value needs the hover-mounted tooltip|only RELATIVE/i);
  });

  it('short values keep the whole-value path (56th-log behavior preserved)', async () => {
    const tools = makeTools(() => [{
      __t_label: '2 hours ago',
      __t_aria: '',
      __t_text: '2 hours ago',
      hovercards: [{ labelledbyText: 'August 23 at 5:30 PM', anchorText: 'Aug 23' }]
    }]);
    const r = await tools.timestamp({ containerSel: 'div.card', index: 0 });
    assert.equal(r.absolute, 'August 23 at 5:30 PM');
    assert.equal(r.relative, '2 hours ago');
  });

  it('the no-candidates note scopes its negative to the anchors hovered, not the page', async () => {
    const tools = makeTools(() => [{
      __t_label: '', __t_aria: '', __t_text: '',
      hovercards: [{ labelledbyText: '', anchorText: 'photo' }]
    }]);
    const r = await tools.timestamp({ containerSel: 'div.card' });
    assert.match(r.note, /anchors THIS call hovered/,
      'an honest scope — a blind call must not license "the page exposes no timestamp"');
    assert.ok(!/page does not expose the timestamp for this population/.test(r.note),
      'the page-level environmental claim is gone');
  });
});

// ---------------------------------------------------------------------------
// Universality guard.
// ---------------------------------------------------------------------------

describe('sixty-fourth log universality guard', () => {
  const FORBIDDEN = /facebook|twitter|linkedin|tiktok|reddit|\bfb\b/i;
  it('the new extraction patterns and notes carry no site tokens', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const wu = fs.readFileSync(path.join(__dirname, '..', 'lib', 'wizard-utils.js'), 'utf8');
    const idx = wu.indexOf('DATE_SUBSTRING_RES');
    assert.ok(idx > -1);
    const block = wu.slice(idx - 1600, idx + 2400);
    assert.ok(!FORBIDDEN.test(block), 'site token in the extraction block');
    const pt = fs.readFileSync(path.join(__dirname, '..', 'lib', 'probe-tools.js'), 'utf8');
    const pushIdx = pt.indexOf('MAX_WHOLE_VALUE_CHARS');
    assert.ok(pushIdx > -1);
    assert.ok(!FORBIDDEN.test(pt.slice(pushIdx - 1200, pushIdx + 2200)), 'site token in the harvest gate');
  });
});
