// Eighty-seventh-round followup (user directive 2026-09-19): the console
// capture must carry EVERYTHING the research loop exchanges. Four gaps
// found in the audit:
//   (1) tool results reached the console ONLY as the model-facing COMPACT
//       detail (head+tail strings, [+N elided] markers) mirrored at a
//       12000-char cap — the RAW result never appeared anywhere;
//   (2) tool-call args mirrored at an 8000-char cap (big service.update
//       step scripts were tail-elided — 33rd-log class recurrence);
//   (3) stopped/finish disclosures mirrored at 600 chars (the 87th finish
//       disclosure showed "[+779 chars elided]" in the console);
//   (4) the user's feedback text (sendSessionFeedback) was never logged at
//       submit time — three feedback rounds in the 86th log were
//       unrecoverable until full request logging landed.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const WIZ_SRC = fs.readFileSync(path.join(__dirname, '..', 'wizard.js'), 'utf8');
const RS_SRC = fs.readFileSync(path.join(__dirname, '..', 'lib', 'research-session.js'), 'utf8');

describe('87th-round log completeness — source wiring audit', () => {
  it('the engine attaches the RAW tool result to the tool_result event', () => {
    assert.match(RS_SRC, /raw:\s*result/, 'toolResultPayload carries raw: result');
  });

  it('the wizard mirrors the RAW result in full (no cap) as TOOL RESULT FULL', () => {
    assert.match(WIZ_SRC, /TOOL RESULT FULL /, 'FULL mirror line exists');
    const i = WIZ_SRC.indexOf("mirrorLines('[session] TOOL RESULT FULL '");
    assert.ok(i !== -1, 'mirrorLines used for the FULL mirror');
    const call = WIZ_SRC.slice(i, i + 200);
    assert.match(call, /Infinity/, 'the FULL mirror passes Infinity (no elision)');
  });

  it('tool-call args mirror with no cap (the 8000 ceiling is gone)', () => {
    const i = WIZ_SRC.indexOf("mirrorLines('[session] TOOL '");
    assert.ok(i !== -1);
    assert.match(WIZ_SRC.slice(i, i + 160), /Infinity/);
  });

  it('detail-bearing session events (stopped/finish) mirror in full, not 600-char clips', () => {
    const i = WIZ_SRC.indexOf("console.log('[session]', ev.type, mirrorClip(JSON.stringify(ev), 600));");
    assert.equal(i, -1, 'the 600-char clip path is gone');
    assert.match(WIZ_SRC, /mirrorLines\('\[session\] ' \+ ev\.type,\s*JSON\.stringify\(ev\),\s*Infinity\)/);
  });

  it('user feedback is logged at submit time', () => {
    // 123rd round: the first occurrence may be inside the identical-feedback
    // breaker probe — anchor on the transcript push's contiguous phrase.
    const i = WIZ_SRC.indexOf("'USER FEEDBACK (fix request): ' + text + '");
    assert.ok(i !== -1);
    // a console mirror of the raw feedback text near the push
    assert.match(WIZ_SRC.slice(Math.max(0, i - 1400), i + 900), /user_feedback/, 'the feedback text is mirrored');
  });

  it('mirrorLines callers that still pass a finite cap are the compact-detail lane only', () => {
    const calls = [...WIZ_SRC.matchAll(/mirrorLines\('\[session\][^;\n]{0,160}?\);/g)].map((m) => m[0]);
    assert.ok(calls.length >= 4, 'call sites found: ' + calls.length);
    const capped = calls.filter((c) => !/Infinity/.test(c));
    for (const c of capped) {
      assert.match(c, /TOOL RESULT DETAIL/, 'unexpected capped mirror: ' + c.slice(0, 60));
    }
  });
});

// Ninetieth-round regression: passing cap=Infinity made `s.length <= cap`
// ALWAYS true — every mirror went out as ONE console line, and DevTools
// silently dropped the ~300K-char verify FULL receipt (the live log's
// "TOOL RESULT FULL verify.run" line carried an EMPTY payload). cap bounds
// the TOTAL; chunking at CONTENT_CHUNK applies whenever the payload exceeds
// one chunk, regardless of cap.
describe('90th-round regression: mirrorLines chunks long payloads even with cap=Infinity', () => {
  const mirrorLines = eval('(function () { return (' + sliceFnWizard('mirrorLines') + '); })()');
  function sliceFnWizard(name) {
    const src = fs.readFileSync(path.join(__dirname, '..', 'wizard.js'), 'utf8');
    const start = src.indexOf('function ' + name + '(');
    let i = src.indexOf('{', start), depth = 0;
    for (; i < src.length; i++) {
      if (src[i] === '{') depth += 1;
      else if (src[i] === '}') { depth -= 1; if (depth === 0) return src.slice(start, i + 1); }
    }
    throw new Error('unbalanced');
  }
  it('a 10K payload logs as 7 chunked lines, never one giant single line', () => {
    const logs = [];
    const orig = console.log;
    console.log = (...a) => logs.push(a);
    try { mirrorLines('[test] big', 'x'.repeat(10000), Infinity); }
    finally { console.log = orig; }
    const chunkLines = logs.filter((a) => /^\[test\] big \(\d+\/\d+\):$/.test(a[0]) || /\(\d+\/\d+\)/.test(String(a[0])));
    assert.ok(chunkLines.length >= 7, 'chunked lines: ' + chunkLines.length + ' — got first: ' + JSON.stringify(logs[0] && logs[0][0]));
    assert.equal(logs.filter((a) => String(a[1] || '').length > 1600).length, 0, 'no payload slice exceeds one chunk');
    assert.ok(!logs.some((a) => /^\[test\] big$/.test(String(a[0])) && String(a[1] || '').length > 1500), 'no giant single-line payload');
  });

  it('a small payload stays a single unchunked line', () => {
    const logs = [];
    const orig = console.log;
    console.log = (...a) => logs.push(a);
    try { mirrorLines('[test] small', 'abc', Infinity); }
    finally { console.log = orig; }
    assert.equal(logs.length, 1);
    assert.equal(logs[0][0], '[test] small');
    assert.equal(logs[0][1], 'abc');
  });
});

// 90th-round F3: clean-JSON copy — hand-selection from the result panel
// dragged the next UI heading into a live result.json export (trailing
// "Steps"). A dedicated Copy JSON button writes the PURE finalResult to the
// clipboard.
describe('90th-round F3: Copy JSON button (clean export)', () => {
  it('wizard.html has the button; presentTestOutcome wires clipboard write of the pure finalResult', () => {
    const html = fs.readFileSync(path.join(__dirname, '..', 'wizard.html'), 'utf8');
    assert.ok(html.includes('id="btnCopyResultJson"'), 'button exists');
    const body = fs.readFileSync(path.join(__dirname, '..', 'wizard.js'), 'utf8');
    const i = body.indexOf('btnCopyResultJson');
    assert.ok(i !== -1, 'wired in wizard.js');
    const block = body.slice(i, i + 900);
    assert.match(block, /navigator\.clipboard\.writeText/, 'clipboard write');
    assert.match(block, /JSON\.stringify\(finalRes, null, 2\)/, 'pretty pure finalResult only — no UI text');
  });
});

// Ninety-seventh-round: $openTab(fn) resolved to ~undefined instantly —
// background wrapped fn.toString() ("async () => {...}" FULL source) inside
// `(async () => { ${scriptStr} })()`, creating the model's arrow but never
// invoking it (live: sub-tab "completed" 141ms after a body containing a
// 4s sleep; snippet got an envelope-shaped stub). Day-one bug.
describe('97th-round: openTab fn-source wrap invokes the function', () => {
  const BG = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');
  it('background detects full function sources and CALLS them (bare bodies keep the body-wrap)', () => {
    assert.match(BG, /isFullFnSource|full function source/, 'detection exists');
    const i = BG.indexOf('executor.execute(script');
    assert.ok(i !== -1);
    const j = BG.indexOf('return await (${fnSource})();');
    assert.ok(j !== -1, 'full-source form is invoked: return await (${fnSource})();');
  });
  it('behavioral: full arrow source returns its body value; bare body still works', () => {
    const fullSrc = 'async () => { return {ran: true}; }';
    const isFullFn = /^(async\s+)?(\([^)]*\)\s*=>|function\s*\w*\s*\()/.test(fullSrc.trim());
    assert.ok(isFullFn, 'arrow source detected as full function');
    const wrapped = isFullFn
      ? new Function('__input__', 'return (' + fullSrc + ')();')
      : new Function('__input__', 'return (async () => { ' + fullSrc + ' })();');
    return wrapped({}).then((r) => assert.deepEqual(r, { ran: true }));
  });
});

// Ninety-eighth-round (ce-debug): the session's FINAL v5 artifact carried a
// step script with pasted evidence-text (not JS) — service.update accepted
// it (validateForExecution never PARSES scripts; syntax errors only surface
// at verify/run), and with no budget left the broken artifact became the
// deployable version behind a prose disclosure. Gate: update-time parse.
describe('98th-round: update-time syntax gate', () => {
  const WU = require('../lib/wizard-utils');
  it('validateForExecution REJECTS a syntactically invalid step script with a locator message', () => {
    const steps = [{ id: 's1', name: 'x', script: 'const a = 1;)\nreturn a;', onSuccess: 'TERMINATE', onFailure: 'TERMINATE' }];
    const out = WU.validateForExecution(steps);
    assert.equal(out.valid, false);
    assert.match(out.error, /SYNTAX|parse/i);
    assert.match(out.error, /s1/);
  });
  it('a pasted-evidence-text script (multi-line prose, no return) is rejected too', () => {
    const steps = [{ id: 's2', name: 'y', script: 'v4 修复意图：isDate 非锚定正则\naria-label 评论计数回退\n如需部署请重写', onSuccess: 'TERMINATE', onFailure: 'TERMINATE' }];
    const out = WU.validateForExecution(steps);
    assert.equal(out.valid, false);
    assert.match(out.error, /SYNTAX|parse/i);
  });
  it('a valid async-body script with top-level await/$ calls passes', () => {
    const steps = [{ id: 's3', name: 'z', script: 'const r = await $extractList(".c",{t:{selector:".t"}}); return r;', onSuccess: 'TERMINATE', onFailure: 'TERMINATE' }];
    const out = WU.validateForExecution(steps);
    assert.equal(out.valid, true, JSON.stringify(out));
  });
});
