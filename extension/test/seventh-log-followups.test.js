// Seventh console.log survey (2026-09-01 13:58→14:36, four wizard runs on a
// search-posts service: keyword "sneakers sale", count 10). The sixth-log
// instrumentation was live and answered the parked per-anchor attribution
// question: 37 hover_anchor_timing events, preDispatchMs avg 8674/max 17191
// (activation roundtrip only ~3s of it; still 7529ms when the tab was already
// active) — the cost is page main-thread work, not activation.
//
// The dominant failure this session is a CARD-POLARITY INVERSION at
// container-selection time. Run 1's generated step 4 used permalink-href
// positive evidence (correct approach) but matched 0 cards (top of a search
// feed is suggestion cards). The failure autoFix — staring at an 80K DOM
// snapshot — needed a structural marker to separate post cards from
// suggestion cards and chose `div[data-ad-rendering-role='story_message']`
// as an INCLUDE filter (`:has(...)`), commenting "a post card contains a
// story_message block". The attribute's NAME says ad-rendering: the selector
// kept ONLY ad cards. CARD-TYPE HETEROGENEITY (a) was in the prompt and even
// recommends "a dedicated data-* rendering attribute" as the exclusion
// signal — text the LLM can read as endorsement of exactly this attribute,
// with the polarity unstated. Consequences: at most ~8 ad cards exist on the
// page, step 3's expander can never reach count 10, the final "SUCCESS"
// returned 1 post — an ad (postId = advertiser page URL), postingTime empty
// — and three more autoFix rounds chased field-level symptoms (popoverSel,
// anchorSel, timestamp regex) without ever questioning the container.
//
//   F1 guide: polarity must be explicit at the moment of marker choice.
//   F2 framework: count=10 was requested; every SUCCESS returned 1 post and
//      nothing compared the two. EMPTY_EXTRACTION catches all-empty,
//      chronic-empty catches field emptiness — no signal catches "severely
//      fewer records than requested". Detect it, surface it to the user,
//      and inject it as an autoFix signal (report-only: forcing the count
//      risks the zero-trap scroll deadlock).
//   F3 observability: extractWithHover_done logs captured/failed counts but
//      never the failure REASONS — this log cannot show whether failures
//      were popover_timeout (observedPopover path) or no_hover_signal, so
//      the sixth-log P1 fix could not be validated from production. Carry a
//      reasons histogram + observedPopoverCount on the done event.

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const WIZARD_SRC = fs.readFileSync(path.join(__dirname, '..', 'wizard.js'), 'utf8');
const CS_SRC = fs.readFileSync(path.join(__dirname, '..', 'content-script.js'), 'utf8');
const {
  detectCountShortfall,
  SCRIPT_DSL_GUIDE
} = require('../lib/wizard-utils');

function setupDOM(html) {
  const dom = new JSDOM(html, { url: 'https://example.com/page' });
  global.document = dom.window.document;
  global.window = dom.window;
  global.Node = dom.window.Node;
  return dom;
}

describe('F1: CARD-TYPE marker polarity is explicit in the guide', () => {
  const idx = SCRIPT_DSL_GUIDE.indexOf('CARD-TYPE HETEROGENEITY');
  const chunk = SCRIPT_DSL_GUIDE.slice(idx, idx + 9000);

  it('has a polarity rule named at the marker-choice moment', () => {
    assert.ok(/POLARITY/.test(chunk),
      'the polarity rule must exist inside CARD-TYPE HETEROGENEITY');
  });

  it('teaches that ad-named attributes are EXCLUDE signals, never :has() includes', () => {
    const ruleIdx = chunk.indexOf('POLARITY');
    const rule = chunk.slice(ruleIdx, ruleIdx + 1800);
    for (const token of ['sponsored', 'promoted']) {
      assert.ok(rule.includes(token),
        'rule must name the promotion tokens (' + token + ') found in attribute names');
    }
    assert.ok(/:not\(|:has\(/.test(rule),
      'rule must show the exclusion selector form');
    assert.ok(/name/i.test(rule),
      'rule must point at the ATTRIBUTE NAME as the polarity tell');
  });

  it('corollary (a) no longer endorses "a dedicated data-* rendering attribute" without polarity', () => {
    const aIdx = chunk.indexOf('(a) a container filter');
    const a = chunk.slice(aIdx, aIdx + 900);
    assert.ok(/name/i.test(a),
      '(a) must warn to read the attribute name for promotion tokens before using it');
  });
});

describe('F2: detectCountShortfall (behavioral)', () => {
  const schema = {
    properties: {
      keyword: { type: 'string' },
      posts: {
        type: 'array',
        items: { type: 'object', properties: { postId: { type: 'string' } } }
      }
    },
    required: ['keyword', 'posts']
  };

  function data(n) {
    const posts = [];
    for (let i = 0; i < n; i++) posts.push({ postId: 'p' + i });
    return { keyword: 'k', posts };
  }

  it('flags the seventh-log shape: 1 post extracted, count 10 requested', () => {
    const s = detectCountShortfall(data(1), { keyword: 'sneakers sale', count: 10 }, schema);
    assert.ok(s, '1/10 must be detected');
    assert.equal(s.field, 'posts');
    assert.equal(s.requested, 10);
    assert.equal(s.extracted, 1);
  });

  it('recognizes count-like input keys beyond plain "count"', () => {
    for (const key of ['limit', 'maxPosts', 'numResults', 'resultCount']) {
      const s = detectCountShortfall(data(2), { q: 'x', [key]: 10 }, schema);
      assert.ok(s, key + ' must be recognized as a requested-count input');
      assert.equal(s.requested, 10);
    }
  });

  it('satisfied counts stay null; minor shortfalls are REPORTED non-severe (forty-sixth log: 3/5 was invisible)', () => {
    assert.equal(detectCountShortfall(data(10), { count: 10 }, schema), null);
    // Forty-sixth log widened the detector: every shortfall reports, with a
    // `severe` flag — the COUNT_SHORTFALL tag/knowledge attach stays
    // severe-only, so 9/10 is disclosed without being nagged.
    const nine = detectCountShortfall(data(9), { count: 10 }, schema);
    assert.ok(nine && nine.extracted === 9 && nine.severe === false, '9/10 reported non-severe');
    const five = detectCountShortfall(data(5), { count: 10 }, schema);
    assert.ok(five && five.severe === true, '5/10 stays severe');
  });

  it('does not flag when no count-like input or tiny requests (noise guard)', () => {
    assert.equal(detectCountShortfall(data(1), { keyword: 'x' }, schema), null);
    assert.equal(detectCountShortfall(data(0), { count: 2 }, schema), null);
  });

  it('tolerates missing schema / non-object data', () => {
    assert.equal(detectCountShortfall(data(1), { count: 10 }, null), null);
    assert.equal(detectCountShortfall(null, { count: 10 }, schema), null);
    assert.equal(detectCountShortfall([1, 2], { count: 10 }, schema), null);
  });
});

describe('F2: verify-runner wires the shortfall signal (source audit, was wizard.js testScript)', () => {
  const RUNNER_SRC = fs.readFileSync(path.join(__dirname, '..', 'lib', 'verify-runner.js'), 'utf8');
  it('success path detects the shortfall and records it report-only', () => {
    const i = RUNNER_SRC.indexOf('WU.detectCountShortfall(finalData');
    const chunk = RUNNER_SRC.slice(i - 400, i + 800);
    assert.ok(/detectors\.countShortfall/.test(chunk),
      'the shortfall must land in the detectors record for the session/user');
    assert.ok(/Report-only/.test(chunk),
      'forcing retries toward an unreachable count is the ZERO-TRAP deadlock — must stay report-only');
  });
  it('the shortfall is published on the detectors record downstream', () => {
    // The detectors record is how verify-runner evidence reaches the session
    // LLM and the user; shortfall evidence rides the report channel.
    const i = RUNNER_SRC.indexOf('detectors.countShortfall');
    assert.ok(i > -1, 'detectors.countShortfall assignment missing');
    const report = RUNNER_SRC.indexOf('detectors: detectors');
    assert.ok(report > -1, 'detectors record must be published on the report');
  });
});

describe('F3: extractWithHover_done carries failure reasons (source audit)', () => {
  beforeEach(() => {
    setupDOM('<!DOCTYPE html><html><body></body></html>');
  });

  it('the done event includes a failureReasons histogram and observedPopoverCount', () => {
    const i = CS_SRC.indexOf("notifyBackgroundDiagnostic('extractWithHover_done'");
    assert.ok(i > -1, 'the done event must exist');
    // 3100-char lookback: the sixty-second-log hoverSummary.enhancedModeDisabled
    // aggregate sits between this tally and the done event (~700 chars).
    const chunk = CS_SRC.slice(i - 3100, i + 700);
    assert.ok(/failureReasons/.test(chunk),
      'failed hover reasons must be tallied onto the event');
    assert.ok(/observedPopoverCount/.test(chunk),
      'observedPopover-bearing failures must be counted (sixth-log P1 validation)');
    assert.ok(/\.reason/.test(chunk),
      'the tally must read each failed entry\'s reason');
  });
});

describe('universality: seventh-log additions carry no site tokens', () => {
  const FORBIDDEN = /facebook|twitter|linkedin|tiktok|reddit|\bfb\b/i;
  it('CARD-TYPE chunk', () => {
    const idx = SCRIPT_DSL_GUIDE.indexOf('CARD-TYPE HETEROGENEITY');
    assert.ok(!FORBIDDEN.test(SCRIPT_DSL_GUIDE.slice(idx, idx + 9000)));
  });
  it('detectCountShortfall source', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'wizard-utils.js'), 'utf8');
    const i = src.indexOf('function detectCountShortfall');
    assert.ok(i > -1);
    assert.ok(!FORBIDDEN.test(src.slice(i, i + 4000)));
  });
});
