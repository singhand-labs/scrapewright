// Regression for console.log 2026-08-23 15:53-16:15 (third session). The
// session finally ran green end-to-end — but posts came back with
// hovercards:[] and postingTime:"" on EVERY record, and a user-feedback
// autoFix round could not repair it. Root cause for hovercards: step 4's
// $extractWithHover anchorSel matched 0 anchor elements inside every
// container (the visible link lives in a sibling branch of the block the
// LLM chained to, nested inside an <object> wrapper). anchor enumeration
// produced an empty array, so hoverFn was NEVER invoked: hover never ran,
// every record got hovercards:[] with ZERO entries — indistinguishable in
// the output from "hovered but no card appeared". hoverSummary.anchorsFound:0
// was computed into the diagnostics channel but nothing consumed it: no
// detector fired, summarizeAllStepDiagnostics had no extractWithHover
// branch, and the autoFix LLM had to GUESS why hovercards were empty
// (guessed wrong twice: first h3 chains, then the wrong ancestor block).

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const wizardSrc = fs.readFileSync(path.join(__dirname, '..', 'wizard.js'), 'utf8');
const utilsSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'wizard-utils.js'), 'utf8');
const contentScriptSrc = fs.readFileSync(path.join(__dirname, '..', 'content-script.js'), 'utf8');
const { detectHoverAnchorsBlind, SCRIPT_DSL_GUIDE } = require('../lib/wizard-utils');

// STEP_ITERATION event builder carrying extractWithHover diagnostics in the
// exact shape domExtractWithHover attaches (wrapper sets processedContainers
// and hoverSummary; anchorSel is added by the same wrapper).
function itEvt(stepId, iteration, diags) {
  return { type: 'STEP_ITERATION', stepId, iteration, selectorDiagnostics: diags };
}
function ehDiag(over) {
  return Object.assign({
    api: 'extractWithHover',
    containerSelector: "div[role='feed'] div[role='article']",
    containerMatches: 8,
    processedContainers: 3,
    anchorSel: "div[profile] a[role='link'][aria-label]",
    hoverSummary: { anchorsFound: 0, hovercardsCaptured: 0, hoverFailures: 0 },
    perField: []
  }, over || {});
}

describe('detectHoverAnchorsBlind — unit', () => {
  it('fires when every processed call found 0 anchors across iterations', () => {
    // Third-log shape: step 4 iterated 3 times (containerRange slices), every
    // call processed containers, anchorsFound stayed 0.
    const events = [
      itEvt('4', 1, [ehDiag({ processedContainers: 3 })]),
      itEvt('4', 2, [ehDiag({ processedContainers: 3 })]),
      itEvt('4', 3, [ehDiag({ processedContainers: 2 })])
    ];
    const hit = detectHoverAnchorsBlind(events);
    assert.ok(hit, 'should fire');
    assert.equal(hit.stepId, '4');
    assert.equal(hit.calls, 3);
    assert.equal(hit.anchorsFound, 0);
    assert.equal(hit.anchorSel, "div[profile] a[role='link'][aria-label]");
    assert.equal(hit.processedCalls, 3);
  });

  it('stays silent when any call matched anchors (matched or recovered)', () => {
    const events = [
      itEvt('4', 1, [ehDiag({ hoverSummary: { anchorsFound: 0, hovercardsCaptured: 0, hoverFailures: 0 } })]),
      itEvt('4', 2, [ehDiag({ hoverSummary: { anchorsFound: 1, hovercardsCaptured: 1, hoverFailures: 0 } })])
    ];
    assert.equal(detectHoverAnchorsBlind(events), null);
  });

  it('stays silent when anchors matched but every hover failed (popover problem, not anchor problem)', () => {
    const events = [
      itEvt('4', 1, [ehDiag({ hoverSummary: { anchorsFound: 3, hovercardsCaptured: 0, hoverFailures: 3 } })])
    ];
    assert.equal(detectHoverAnchorsBlind(events), null);
  });

  it('stays silent when all calls saw 0 containers (container-blind is a different failure)', () => {
    const events = [
      itEvt('4', 1, [ehDiag({ containerMatches: 0, processedContainers: 0 })])
    ];
    assert.equal(detectHoverAnchorsBlind(events), null);
  });

  it('mixed calls: processed 0-anchor calls fire even alongside allowEmpty early-return calls', () => {
    const events = [
      itEvt('4', 1, [
        ehDiag({ containerMatches: 0, processedContainers: 0, anchorSel: "div[profile] a" }),
        ehDiag({ processedContainers: 3 })
      ])
    ];
    const hit = detectHoverAnchorsBlind(events);
    assert.ok(hit, 'the processed call with 0 anchors is anchor-blind');
    assert.equal(hit.calls, 2);
    assert.equal(hit.processedCalls, 1);
  });

  it('ignores steps whose diagnostics are not extractWithHover', () => {
    const events = [
      itEvt('2', 1, [{ api: 'count', selector: 'div[x]', matchCount: 0 }]),
      itEvt('2', 2, [{ api: 'extractList', containerSelector: 'div[x]', containerMatches: 5, perField: [] }])
    ];
    assert.equal(detectHoverAnchorsBlind(events), null);
  });

  it('returns null for empty / null / malformed inputs', () => {
    assert.equal(detectHoverAnchorsBlind([]), null);
    assert.equal(detectHoverAnchorsBlind(null), null);
    assert.equal(detectHoverAnchorsBlind(undefined), null);
    assert.equal(detectHoverAnchorsBlind([{ type: 'OTHER' }, {}]), null);
    assert.equal(detectHoverAnchorsBlind([{ type: 'STEP_ITERATION', stepId: '4', selectorDiagnostics: [{}] }]), null);
  });
});

describe('wizard.js testScript success-path wiring', () => {
  it('success path runs detectHoverAnchorsBlind and throws HOVER_ANCHORS_BLIND', () => {
    assert.ok(/detectHoverAnchorsBlind\(/.test(wizardSrc), 'detectHoverAnchorsBlind not called in wizard.js');
    assert.ok(/HOVER_ANCHORS_BLIND/.test(wizardSrc), 'HOVER_ANCHORS_BLIND marker missing');
    // Must sit in the success-path guard block (after CLICK_CONTAINERS_EMPTY),
    // not only in a catch branch.
    const idx = wizardSrc.indexOf('CLICK_CONTAINERS_EMPTY');
    const idx2 = wizardSrc.indexOf('detectHoverAnchorsBlind');
    assert.ok(idx > 0 && idx2 > idx, 'HOVER_ANCHORS_BLIND check not downstream of CLICK_CONTAINERS_EMPTY');
  });

  it('the thrown message teaches the container-scoped anchor contract', () => {
    const m = wizardSrc.match(/HOVER_ANCHORS_BLIND[\s\S]{0,1200}/);
    assert.ok(m, 'message block not found');
    assert.ok(/INSIDE each container|inside each container/.test(m[0]), 'container-scope contract missing');
    assert.ok(/hover never ran|hover NEVER ran|hover did not run/i.test(m[0]), 'hover-never-ran statement missing');
    assert.ok(/wrapper|<object>|aria-hidden/i.test(m[0]), 'wrapper-nesting hint missing');
  });
});

describe('summarizeAllStepDiagnostics surfaces extractWithHover', () => {
  it('has an extractWithHover branch rendering anchorsFound', () => {
    assert.ok(/extractWithHover/.test(utilsSrc), 'no extractWithHover handling');
    // The summary line must show the anchor counts, not just containers.
    assert.ok(/anchors found/i.test(utilsSrc), 'anchorsFound not rendered');
  });

  it('flags the anchor-blind case explicitly (0 anchors, containers processed)', () => {
    assert.ok(/ANCHOR BLIND/.test(utilsSrc), 'ANCHOR BLIND marker missing');
    assert.ok(/anchorSel/.test(utilsSrc), 'anchorSel not named in summary');
  });
});

describe('diagnostics carry anchorSel + SW-console mirroring (content-script)', () => {
  it('domExtractWithHover attaches anchorSel to _diagnostics', () => {
    assert.ok(/_diagnostics\.anchorSel\s*=\s*hoverConfig\.anchorSel/.test(contentScriptSrc),
      '_diagnostics.anchorSel assignment missing');
  });

  it('mirrors extractWithHover entry/exit to the background SW console', () => {
    // This log capture (SW console) showed scroll events but NOTHING from the
    // extractWithHover wrapper — its sendDebugLog calls only reach the page
    // console. Mirror like scrollToBottom_* does so future captures show
    // containers/anchorSel/anchorsFound.
    const calls = contentScriptSrc.match(/notifyBackgroundDiagnostic\('extractWithHover[^']*'/g) || [];
    assert.ok(calls.length >= 2, 'expected entry + done mirror events, got ' + calls.length);
  });
});

describe('DSL guide teaches the anchor-scope trap', () => {
  it('EXTRACT-WITH-HOVER section states anchorSel is container-scoped', () => {
    assert.match(SCRIPT_DSL_GUIDE, /anchorSel[\s\S]{0,400}container\.querySelectorAll|container\.querySelectorAll[\s\S]{0,400}anchorSel/);
    assert.match(SCRIPT_DSL_GUIDE, /INSIDE each container/i);
  });

  it('names the wrapper-nesting trap (object / aria-hidden shells)', () => {
    assert.match(SCRIPT_DSL_GUIDE, /<object>|object wrapper|aria-hidden shell/i);
  });

  it('teaches the 0-anchor signature: hovercards:[] with ZERO entries', () => {
    assert.match(SCRIPT_DSL_GUIDE, /hovercards:\s*\[\][\s\S]{0,300}zero\s+entries|zero\s+entries[\s\S]{0,300}hovercards:\s*\[\]/i);
  });
});

describe('DSL guide — heterogeneous cards / contradictory filters', () => {
  it('warns that a field empty on ALL records may mean wrong card TYPE kept', () => {
    assert.match(SCRIPT_DSL_GUIDE, /promoted|sponsored/i);
    assert.match(SCRIPT_DSL_GUIDE, /empty\s+on\s+(every|all)\s+record|chronically\s+empty/i);
  });

  it('warns against keep-here/exclude-there filter contradictions between steps', () => {
    assert.match(SCRIPT_DSL_GUIDE, /contradictor/i);
  });
});

describe('universality — no site-specific names in new texts', () => {
  it('wizard-utils.js contains no forbidden site tokens', () => {
    const forbidden = ['facebook', 'twitter', 'linkedin', 'tiktok', 'reddit', 'fb'];
    for (const term of forbidden) {
      assert.ok(!new RegExp(term, 'i').test(utilsSrc), `site-specific term "${term}" present in wizard-utils.js`);
    }
  });
});
