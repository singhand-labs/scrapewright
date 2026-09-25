// extension/test/hundred-forty-sixth-log-tail-completion.test.js
//
// 146th log: the session died at turn 64 with stop reason "protocol" —
// "not-object — Expected ',' or '}' after property value in JSON at position
// 2559" on a 2561-char reply with finish_reason:"stop" (the provider cut the
// FINAL CLOSING BRACE and lied about stopping — the 126th-round ~2.5K
// ceiling class, eighth recurrence). The repair stack had TWO compounding
// gaps:
//
//   A. The 54th-log close-braces salvage correctly computed the missing
//      closer (its scan is quote/escape-AWARE) — and then REJECTED the
//      repair because salvaged.tool === 'service.update' (the payload
//      guard: "a cut inside payload arguments would silently truncate the
//      artifact — keep the loud cut-off path"). The guard cannot
//      distinguish a cut MID-CONTENT (lossy) from a cut AFTER-CONTENT
//      missing only closers (LOSSLESS — nothing is dropped).
//   B. The loud path it routed to never fired: the cut-off marker comes
//      from bracesBalanced() — a NAIVE, string-blind brace count — and the
//      step scripts' internal braces ({done:false, posts:out}) offset the
//      missing closer exactly, so the marker read "balanced", the
//      continuation gate (stillCutOff regex) stayed closed, and the
//      session stopped 5ms later.
//
// Fixes under test:
//   A1. The payload guard allows the salvage when the completion is
//       CLOSER-ONLY (no open string at EOF; the appended suffix contains
//       only closing brackets) — the full steps array survives intact.
//   B1. The not-object cut-off marker uses the string-aware scan (a reply
//       with a genuinely unclosed structure gets the marker even when the
//       naive count looks balanced); mid-string cuts keep the loud path.
//
// No site tokens.
const { test, describe, it } = require('node:test');
const assert = require('assert');

const Protocol = require('../lib/session-protocol');

// The incident shape: a service.update turn whose scripts contain braces
// (breaking the naive count) and whose final closing brace the provider cut.
const FULL_TURN = {
  think: 'final chunk assembling the artifact',
  tool: 'service.update',
  args: {
    steps: [
      { id: 'collect', name: 'scroll collect', onSuccess: 'extract', maxIterations: 40,
        script: 'const want=Math.min(Number(__input__.count)||10,50);await $scrollBy(2000);if(out.length>=want) return {done:true, posts:out.slice(0,want)};return {done:false, posts:out};' },
      { id: 'extract', name: 'extract posts', onSuccess: 'TERMINATE', onFailure: 'TERMINATE',
        script: 'return {done:false, posts:out};' }
    ]
  }
};

function cutFinalBrace(obj) {
  const s = JSON.stringify(obj);
  return s.slice(0, -1); // drop the outermost closing brace — the incident
}

describe('146th log A — lossless tail completion for payload tools', () => {
  it('a service.update reply missing ONLY its final brace parses with the FULL steps intact (closer-only salvage allowed)', () => {
    const p = Protocol.parseAssistantTurn(cutFinalBrace(FULL_TURN));
    assert.ok(p.ok, 'parsed — got ' + JSON.stringify(p).slice(0, 200));
    assert.equal(p.turn.tool, 'service.update');
    assert.equal(p.turn.args.steps.length, 2, 'no step silently dropped');
    assert.match(p.turn.args.steps[0].script, /done:false, posts:out/);
    assert.equal(p.turn.args.steps[1].onFailure, 'TERMINATE', 'the LAST property before the cut survives');
  });

  it('a cut INSIDE a payload string (mid-content) keeps the loud path — salvage still refuses', () => {
    const s = JSON.stringify(FULL_TURN);
    const cutMid = s.slice(0, s.length - 30); // cut inside the tail of the last script string
    const p = Protocol.parseAssistantTurn(cutMid);
    assert.ok(!p.ok, 'not-object — the lossy cut is not silently salvaged');
    assert.match(p.detail, /cut-off|Unterminated/i, 'the loud cut-off marker is present for the continuation gate');
  });

  it('non-payload tools with closer-only cuts keep working (regression)', () => {
    const probe = { think: 't', tool: 'probe.count', args: { sel: '.card' } };
    const p = Protocol.parseAssistantTurn(JSON.stringify(probe).slice(0, -1));
    assert.ok(p.ok, 'cheap-probe salvage unaffected — got ' + JSON.stringify(p).slice(0, 160));
    assert.equal(p.turn.tool, 'probe.count');
  });
});

describe('146th log B — string-aware cut-off marker', () => {
  it('a reply whose scripts offset the naive brace count still earns the cut-off marker when structure is genuinely unclosed', () => {
    // service.update with a mid-string cut AND brace-balanced-looking
    // scripts: the naive count says balanced, the string-aware scan does not.
    const s = JSON.stringify(FULL_TURN);
    const cutMid = s.slice(0, s.length - 24);
    const p = Protocol.parseAssistantTurn(cutMid);
    assert.ok(!p.ok);
    assert.match(p.detail, /cut-off/, 'marker present despite balanced naive count — got ' + JSON.stringify(p.detail).slice(0, 200));
  });

  it('the closer-only salvage yields the IDENTICAL turn object to parsing the uncut JSON', () => {
    const repaired = Protocol.parseAssistantTurn(cutFinalBrace(FULL_TURN));
    const reference = Protocol.parseAssistantTurn(JSON.stringify(FULL_TURN));
    assert.ok(repaired.ok && reference.ok);
    assert.deepEqual(repaired.turn, reference.turn, 'byte-perfect recovery — the salvage added only closers');
  });
});
