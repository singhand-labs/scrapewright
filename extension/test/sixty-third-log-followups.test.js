// Sixty-third log (2026-09-11, wizard.html/service_worker/offscreen console
// exports, session rs-1789104036396-1, glm-5.3, FB search, fresh session,
// died at protocol ~35 turns — never reached io.confirm/service.update/
// verify.run). Two root causes, both confirmed from the logs:
//
// RC1 — HOVER AT (400,400). Three of five anchors in one $extractWithHover
// batch dispatched at EXACTLY (400,400): content-script.js's degenerate-rect
// fallback. The anchorSel union (`a:has(span[aria-labelledby]),
// [aria-labelledby], abbr[aria-label], time`) matched HIDDEN tooltip spans —
// display:none elements with zero boxes. The old code dispatched the trusted
// mouseMoved at a fixed viewport point unrelated to the anchor, ran the full
// dwell (~3s × 3) + dismiss, and reported no_hover_signal_early_exit — which
// reads as "this anchor has no popover" when hover was structurally
// impossible. Same genre as the sixty-second log: a deterministic structural
// condition reported under an evidence-shaped reason.
//
// RC2 — THE SESSION-KILLER JSON CLASS. Both terminal protocol violations
// (and the two repaired ones mid-session) were replies whose think prose
// quoted page evidence ("Like: 179 people", "Wow: 11 people") with
// unescaped inner quotes while the args were PERFECTLY escaped. The
// repairUnescapedQuotes closer-set heuristic (a quote followed by ,/}/]/:
// closes the string) mis-fires exactly on prose that quotes two things
// comma-separated — `"people", "Wow"` is indistinguishable from a value
// close + the next key. Fix: position-guided iterative escaping in
// parseJsonLenient — the V8 parse error names the exact position of the
// structural expectation failure; escape the quote that prematurely closed
// the value and re-parse, one quote per round, two error classes only
// (property-value / property-name). Truncation and trailing-junk classes
// stay with their existing owners (close-braces salvage, continuation
// round). Both real replies now parse deterministically — the repair round,
// the second failure, and the protocol stop all evaporate.
//
// Also verified from this log (no fix needed): the two model selector typos
// (`div[rolearticle"]`, `[aria-posinset"]` — missing opening quotes) were
// surfaced honestly through the full relay chain and self-corrected in one
// turn each (the offscreen error lines are their sandbox-side echoes); the
// 32K corrupted provider reply recovered through the existing violation +
// nudge path; the model's "6/60 budget nearly gone" think was its own
// miscount (the first budget advisory fired at turn 30, after).

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');
const { parseJsonLenient } = require('../lib/wizard-utils');
const Protocol = require('../lib/session-protocol');

function readSrc(rel) {
  return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
}

function sliceFn(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.ok(start > -1, 'marker not found: ' + startMarker);
  const end = source.indexOf(endMarker, start);
  assert.ok(end > start, 'end marker not found after start: ' + endMarker);
  return source.slice(start, end);
}

// ---------------------------------------------------------------------------
// F2: position-guided inner-quote repair.
// ---------------------------------------------------------------------------

// Verbatim from the log (wizard.html.console.log lines ~1547-1590, response
// chunks 1/1 of the two replies that produced the terminal protocol stop).
const REPLY_1 = '{"think":"Counts found: nested divs carry aria-label="Like: 179 people"/"Wow: 11 people" inside the reaction toolbar. Bind likeCount = div[aria-label^="Like: "] attr. Comment counts usually live on comment_id links — probe those.","goals":null,"hypotheses":null,"tool":"probe.text","args":{"sel":"div[role=feed] div[aria-posinset] a[href*=\\"comment_id\\"]"}}';
const REPLY_2 = '{"think":"Reaction counts live in inner divs\' aria-label ("Like: 179 people", "Wow: 11 people") inside the See-who-reacted toolbar. Now check comment-count anchors (href with comment_id).","goals":null,"hypotheses":null,"tool":"probe.text","args":{"sel":"div[role=feed] div[aria-posinset] a[href*=comment_id]"}}';

describe('sixty-third log F2: position-guided inner-quote repair', () => {
  it('REPLY 1 (":"] closer-set killer) parses with args preserved byte-for-byte', () => {
    const out = parseJsonLenient(REPLY_1);
    assert.ok(out.ok, 'parses: ' + (out.error || ''));
    assert.ok(out.repairs.includes('escape-inner-quotes'), 'repair recorded: ' + JSON.stringify(out.repairs));
    assert.equal(out.value.tool, 'probe.text');
    // The model escaped the sel correctly — the repair must not touch it.
    assert.equal(out.value.args.sel, 'div[role=feed] div[aria-posinset] a[href*="comment_id"]');
    // The think prose keeps its quoted evidence.
    assert.ok(out.value.think.includes('"Like: 179 people"'));
  });

  it('REPLY 2 (comma-quote prose — the value-close+key ambiguity) parses', () => {
    const out = parseJsonLenient(REPLY_2);
    assert.ok(out.ok, 'parses: ' + (out.error || ''));
    assert.equal(out.value.tool, 'probe.text');
    assert.equal(out.value.args.sel, 'div[role=feed] div[aria-posinset] a[href*=comment_id]');
    assert.ok(out.value.think.includes('"Wow: 11 people"'));
  });

  it('end-to-end: parseAssistantTurn returns the committed tool turn both replies died on', () => {
    for (const r of [REPLY_1, REPLY_2]) {
      const p = Protocol.parseAssistantTurn(r);
      assert.ok(p.ok, 'protocol parses the reply: ' + JSON.stringify(p).slice(0, 200));
      assert.equal(p.turn.tool, 'probe.text');
    }
  });

  it('already-valid JSON is untouched (zero repairs)', () => {
    const out = parseJsonLenient('{"think":"clean","tool":"finish","finish":{"summary":"a \\"quoted\\" word"}}');
    assert.ok(out.ok);
    assert.deepEqual(out.repairs, []);
  });

  it('already-escaped quotes are never double-escaped', () => {
    const src = '{"think":"he said \\"ok\\" then quoted "July 22" aloud","tool":"probe.text","args":{"sel":"a"}}';
    const out = parseJsonLenient(src);
    assert.ok(out.ok, 'parses: ' + (out.error || ''));
    assert.equal(out.value.think, 'he said "ok" then quoted "July 22" aloud');
  });

  it('genuinely truncated replies stay failing (salvage/continuation classes own them)', () => {
    const out = parseJsonLenient('{"think":"half way","tool":"probe.text","args":{"sel":"div[x');
    assert.equal(out.ok, false, 'an unterminated string must not be force-repaired into wrong JSON');
  });

  it('trailing junk after a closed object stays failing', () => {
    const out = parseJsonLenient('{"think":"ok","tool":"probe.text","args":{"sel":"a[href]"}}  ND("}');
    assert.equal(out.ok, false);
  });

  it('many inner quotes converge within the round bound', () => {
    const quotes = Array.from({ length: 8 }, (_, i) => '"tag ' + i + '"').join(', ');
    const src = '{"think":"census: ' + quotes + ' all matched","goals":null,"hypotheses":null,"tool":"probe.text","args":{"sel":"a"}}';
    const out = parseJsonLenient(src);
    assert.ok(out.ok, '8 inner quote-pairs converge: ' + (out.error || ''));
    assert.ok(out.value.think.includes('"tag 7"'));
  });
});

// ---------------------------------------------------------------------------
// F1: domHover degenerate-rect early-out.
// ---------------------------------------------------------------------------

const HARVEST_DEPS_SRC =
  sliceFn(readSrc('content-script.js'), 'function resolveLabelledbyText(', '\n  async function domLabelledby') +
  '\n' +
  sliceFn(readSrc('content-script.js'), 'function harvestAnchorLabel(', '\n  async function domHover(');

function sliceDomHover(src) {
  return sliceFn(src, 'async function domHover(', 'async function domExtractWithHover(');
}

// The hidden-anchor shape from the log: a display:none tooltip-ish span a
// broad union anchorSel matched. JSDOM rects are all-zero (no layout engine)
// — exactly the degenerate shape the gate must catch.
function makeHiddenAnchorDom() {
  const dom = new JSDOM(
    '<span id="vis">June 21</span>' +
    '<span id="tip" style="display:none">June 21, 2024 at 3:15 PM</span>' +
    '<a id="anchor" class="a" href="/x" aria-labelledby="vis tip" style="display:none">x</a>',
    { url: 'https://example.com/page' }
  );
  const anchor = dom.window.document.getElementById('anchor');
  anchor.scrollIntoView = function () {};
  return { dom, anchor };
}

function gateHoverContext(dom, anchor) {
  const sent = [];
  const diags = [];
  return {
    ctx: {
      document: dom.window.document,
      window: dom.window,
      Node: dom.window.Node,
      MutationObserver: dom.window.MutationObserver,
      Date: Date,
      setTimeout: (fn) => { fn(); },
      chrome: {
        runtime: {
          sendMessage: async (m) => {
            sent.push(m.type);
            return { dispatched: true, ok: true };
          }
        }
      },
      withTabActivation: async (label, fn) => fn(),
      notifyBackgroundDiagnostic: (name, payload) => { diags.push({ name, payload }); },
      sendDebugLog: () => {},
      querySelectorDeep: (sel) => (sel === '.a' ? { element: anchor } : null),
      querySelectorAllDeep: () => [anchor],
      isElementVisible: () => true,
      collectRejectedAddedTexts: () => [],
      harvestAnchorLabel: () => null,
      popoverIdentityOf: () => ({ tag: 'DIV' })
    },
    sent,
    diags
  };
}

describe('sixty-third log F1: domHover degenerate-rect early-out', () => {
  it('zero-box anchor → anchor_not_hoverable, no dispatch/dwell/dismiss, harvest preserved', async () => {
    const { dom, anchor } = makeHiddenAnchorDom();
    const { ctx, sent, diags } = gateHoverContext(dom, anchor);
    vm.createContext(ctx);
    vm.runInContext(HARVEST_DEPS_SRC + '\n' + sliceDomHover(readSrc('content-script.js')) + '\nthis.__domHover = domHover;', ctx);
    const hoverFn = ctx.__domHover;

    const r = await hoverFn('.a', null, { timeoutMs: 5000 });

    assert.equal(r.hovered, false);
    assert.equal(r.hoverDispatched, false);
    assert.equal(r.reason, 'anchor_not_hoverable');
    assert.equal(r.anchorRect.width, 0);
    assert.match(r.budgetNote, /display:none or zero size/i, 'names the structural cause');
    assert.match(r.budgetNote, /do NOT retry/i, 'deterministic — the opposite of the transient teaching');
    assert.match(r.budgetNote, /labelledby/, 'teaches the still-working non-hover routes');
    assert.match(r.budgetNote, /VISIBLE/i, 'teaches narrowing the anchorSel');
    assert.equal(sent.length, 0,
      'no TRUSTED_HOVER_REQUEST, no dismiss — the whole CDP pipeline is skipped for an anchor with no box');
    const req = diags.find((d) => d.name === 'hover_request');
    assert.ok(req, 'the skip is observable as a hover_request diagnostic');
    assert.equal(req.payload.dispatched, false);
    assert.equal(req.payload.reason, 'anchor_not_hoverable');
    assert.equal(r.labelledbyText, 'June 21 June 21, 2024 at 3:15 PM',
      'the anchor-label harvest still runs — hidden elements are readable without a box');
  });

  it('source audit: the (400,400) fallback is gone; coordinates are the anchor center only', () => {
    const body = sliceDomHover(readSrc('content-script.js'));
    assert.ok(!/: 400;/.test(body),
      'no fixed-point coordinate fallback may survive in the dispatch path');
    assert.match(body, /rect\.width <= 0 \|\| rect\.height <= 0/,
      'the degenerate gate covers BOTH zero width and zero height');
    const gateIdx = body.indexOf('anchor_not_hoverable');
    const coordIdx = body.indexOf('Math.round(rect.left + rect.width / 2)');
    assert.ok(gateIdx > -1 && coordIdx > gateIdx,
      'the gate precedes the coordinate computation');
  });

  it('SCRIPT_DSL_GUIDE teaches the ANCHOR MUST HAVE A BOX rule', () => {
    const src = readSrc('lib/wizard-utils.js');
    const idx = src.indexOf('ANCHOR MUST HAVE A BOX');
    assert.ok(idx > -1, 'the guide rule exists');
    const line = src.slice(idx, idx + 700);
    assert.match(line, /anchor_not_hoverable/);
    assert.match(line, /do not retry/i);
    assert.match(line, /VISIBLE interactive elements/i);
  });
});

// ---------------------------------------------------------------------------
// Universality guard.
// ---------------------------------------------------------------------------

describe('sixty-third log universality guard', () => {
  const FORBIDDEN = /facebook|twitter|linkedin|tiktok|reddit|\bfb\b/i;
  it('the new repair and gate strings carry no site tokens', () => {
    const strings = [
      readSrc('lib/wizard-utils.js').slice(
        readSrc('lib/wizard-utils.js').indexOf('function escapePrematureQuoteClosers'),
        readSrc('lib/wizard-utils.js').indexOf('function escapePrematureQuoteClosers') + 3500),
      sliceDomHover(readSrc('content-script.js')).slice(
        sliceDomHover(readSrc('content-script.js')).indexOf('anchor_not_hoverable') - 1400,
        sliceDomHover(readSrc('content-script.js')).indexOf('anchor_not_hoverable') + 1800),
      readSrc('lib/wizard-utils.js').slice(
        readSrc('lib/wizard-utils.js').indexOf('ANCHOR MUST HAVE A BOX'),
        readSrc('lib/wizard-utils.js').indexOf('ANCHOR MUST HAVE A BOX') + 700)
    ];
    for (const s of strings) {
      assert.ok(!FORBIDDEN.test(s), 'site token in new code string: ' + String(s).slice(0, 120));
    }
  });
});
