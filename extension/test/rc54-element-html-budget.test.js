// RC54: confirmSelectorsWithFullHtml must cap the element HTML embedded in
// its prompt.
//
// FOLLOWUP to RC53 (console.log 2026-08-14 13:51-13:5x). The wizard Round 2
// prompt reached 756,464 prompt tokens (5.5x the RC52 incident's 136,953).
// Round 1 returned 24 candidates including CONTAINER selectors
// (role=main, role=feed) whose outerHTML embeds the entire rendered feed;
// getElementFullHtml (lib/dom-cleaner.js) has no size cap, and every
// candidate repeats that content (plus literal duplicates — input[type=
// "search"] and input[placeholder=...] matched the SAME element and were
// embedded twice). Consequences in the log: attempt 1 timed out at 120s;
// attempt 2 succeeded only by luck (~78s, just under the timeout), burning
// 756K billed input tokens. A slightly larger page makes Round 2
// deterministically un-executable under any reasonable timeout.
//
// Fix: a pure formatter (formatElementsForPrompt in lib/wizard-utils.js)
// applies TWO caps when building the Elements section:
//   - per-element: outerHTML truncated to RC54_MAX_ELEMENT_HTML_CHARS with
//     a [TRUNCATED: first N of M chars] marker (the opening tag + leading
//     children carry the structural signal; a 500K-char container dump has
//     none beyond the first screenful).
//   - total: once RC54_TOTAL_ELEMENTS_BUDGET_CHARS is exhausted, remaining
//     found-elements are listed as [SKIPPED: budget exhausted] — the
//     selector stays visible so the LLM can still confirm from context.
//
// NOT a prompt-length problem (Round 3, 33K prompt): its failures were two
// 120s proxy timeouts + one RC52-class empty-content finish_reason:length
// at the 8192 default — addressed by the RC53 maxOutputTokens config knob,
// not by this cap.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { formatElementsForPrompt } = require('../lib/wizard-utils');

function readSrc(rel) {
  return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
}

describe('RC54: formatElementsForPrompt per-element truncation', () => {
  it('returns short element HTML unchanged and preserves NOT FOUND entries', () => {
    const out = formatElementsForPrompt([
      { selector: 'div.result', found: true, outerHTML: '<div class="result">text</div>' },
      { selector: 'div.gone', found: false }
    ]);
    assert.ok(out.includes('--- div.result ---\n<div class="result">text</div>'));
    assert.ok(out.includes('--- div.gone ---\nNOT FOUND'));
  });

  it('truncates oversized outerHTML with a marker noting the original length', () => {
    const html = '<div class="container">' + 'x'.repeat(50000) + '</div>';
    const out = formatElementsForPrompt([{ selector: 'div.container', found: true, outerHTML: html }]);
    assert.ok(!out.includes(html), 'full 50K-char HTML must not be embedded');
    assert.ok(out.includes(html.slice(0, 30000)), 'first 30000 chars must be kept');
    assert.match(out, /\[TRUNCATED: first 30000 of \d+ chars\]/,
      'marker must disclose the truncation and original size');
  });

  it('custom perElementCapChars is honored', () => {
    const html = 'y'.repeat(1000);
    const out = formatElementsForPrompt(
      [{ selector: 'span.item', found: true, outerHTML: html }],
      { perElementCapChars: 100 }
    );
    assert.ok(out.includes('y'.repeat(100)));
    assert.ok(!out.includes('y'.repeat(101)));
  });
});

describe('RC54: formatElementsForPrompt total budget', () => {
  it('marks elements past the budget as SKIPPED but keeps their selectors listed', () => {
    const html = 'z'.repeat(120000); // truncated to 30K per element
    const out = formatElementsForPrompt([
      { selector: 'div.first', found: true, outerHTML: html },
      { selector: 'div.second', found: true, outerHTML: html },
      { selector: 'div.third', found: true, outerHTML: html }
    ], { totalBudgetChars: 40000 });
    assert.ok(out.includes('--- div.first ---'));
    assert.ok(out.includes('z'.repeat(30000)), 'first element still embedded (truncated)');
    assert.match(out, /--- div\.second ---\n\[SKIPPED[^\n]*\]/,
      'second element must be skipped once budget is exhausted');
    assert.match(out, /--- div\.third ---\n\[SKIPPED[^\n]*\]/,
      'skip is sticky — later elements are skipped too, selectors still listed');
  });

  it('default caps bound the Elements section well under RC52-scale prompts', () => {
    // 30 candidates x 500K-char containers = 15M chars uncapped
    // (the RC54 incident shape: 24 candidates, 756K prompt tokens).
    const elements = [];
    for (let i = 0; i < 30; i++) {
      elements.push({ selector: 'div.cand-' + i, found: true, outerHTML: 'q'.repeat(500000) });
    }
    const out = formatElementsForPrompt(elements);
    assert.ok(out.length < 250000,
      'total Elements section must stay bounded (~200K chars); got ' + out.length);
    for (let i = 0; i < 30; i++) {
      assert.ok(out.includes('--- div.cand-' + i + ' ---'),
        'every candidate selector must remain listed');
    }
  });
});

describe('RC54: wizard.js wires the capped formatter', () => {
  it('confirmSelectorsWithFullHtml builds the Elements section via formatElementsForPrompt', () => {
    const src = readSrc('wizard.js');
    const start = src.indexOf('async function confirmSelectorsWithFullHtml(');
    assert.ok(start > -1, 'confirmSelectorsWithFullHtml must exist');
    const end = src.indexOf('\nasync function ', start + 1);
    const body = src.slice(start, end > start ? end : start + 8000);
    assert.ok(body.includes('formatElementsForPrompt(response.elements)'),
      'the Elements section must be built through the capped formatter — raw ' +
      'outerHTML embedding produced a 756,464-token prompt (RC54 incident)');
    assert.ok(!/e\.outerHTML\s*\}/.test(body),
      'no raw outerHTML interpolation may remain in the prompt template');
  });

  it('comment documents the RC54 incident at the Elements build site', () => {
    const src = readSrc('wizard.js');
    const idx = src.indexOf('formatElementsForPrompt(response.elements)');
    assert.ok(idx > -1, 'wiring must exist');
    const before = src.slice(Math.max(0, idx - 900), idx);
    assert.ok(/RC54|756,?464|budget/i.test(before),
      'a comment near the Elements build must document WHY the cap exists ' +
      '(756K-token Round 2 prompt, 120s timeout coin-flip on attempt 2).');
  });

  it('formatElementsForPrompt is exported from wizard-utils for wizard.html global sharing', () => {
    const src = readSrc('lib/wizard-utils.js');
    assert.ok(/function formatElementsForPrompt\(/.test(src),
      'formatter must be defined in wizard-utils.js');
    assert.match(src, /module\.exports[^\n]*formatElementsForPrompt/,
      'formatter must appear in module.exports');
  });
});
