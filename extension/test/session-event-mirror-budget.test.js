// Twenty-third log RC-C raised the stopped-event mirror from 200 to 600
// chars — but the slice stayed head-only. Twenty-sixth log: BOTH stopped
// events of the session were cut mid-sentence at char ~600 with no
// truncation marker, and the honest-ship disclosure suffix
// ("[VERIFY PARTIAL-EMPTY — ...]") is APPENDED TO THE TAIL of the detail —
// so in exported console logs the disclosure is systematically invisible
// exactly when it matters. mirrorClip keeps head AND tail with an explicit
// elision marker.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'wizard.js'), 'utf8');

function sliceFn(name) {
  const start = SRC.indexOf('function ' + name + '(');
  assert.ok(start !== -1, 'function ' + name + ' exists in wizard.js');
  let i = SRC.indexOf('{', start);
  let depth = 0;
  for (; i < SRC.length; i++) {
    if (SRC[i] === '{') depth += 1;
    else if (SRC[i] === '}') { depth -= 1; if (depth === 0) return SRC.slice(start, i + 1); }
  }
  throw new Error('unbalanced braces for ' + name);
}

const mirrorClip = eval('(function () { return (' + sliceFn('mirrorClip') + '); })()');

describe('mirrorClip (twenty-sixth log: tail disclosure must survive)', () => {
  it('short strings pass through untouched', () => {
    assert.equal(mirrorClip('{"type":"paused"}', 600), '{"type":"paused"}');
  });

  it('long strings keep head AND tail with an elision marker', () => {
    const head = 'H'.repeat(400);
    const mid = 'M'.repeat(1000);
    const tail = '[VERIFY PARTIAL-EMPTY — confirmed field(s) empty]';
    const s = head + mid + tail;
    const clipped = mirrorClip(s, 600);
    assert.ok(clipped.length < 700, 'clipped output stays near budget, got ' + clipped.length);
    assert.ok(clipped.startsWith(head.slice(0, 100)), 'head preserved');
    assert.ok(clipped.indexOf(tail) !== -1, 'TAIL preserved — the disclosure suffix lives here');
    assert.match(clipped, /\[\+\d+ chars?\]/, 'elision is explicit, not a silent mid-sentence cut');
  });

  it('marker names the elided char count', () => {
    const s = 'a'.repeat(1600);
    const clipped = mirrorClip(s, 600);
    const m = /\[\+(\d+) chars?\]/.exec(clipped);
    assert.ok(m, 'marker present');
    const elided = parseInt(m[1], 10);
    const parts = clipped.split(/…\[\+\d+ chars?\]…/);
    assert.equal(parts.length, 2, 'exactly one marker between head and tail');
    const kept = parts[0].length + parts[1].length;
    assert.equal(kept + elided, 1600, 'kept + elided == original length');
  });
});

describe('wizard.js session-event mirror budgets (RC-C + twenty-sixth log)', () => {
  it('all three mirror branches route through mirrorClip, not a bare head slice', () => {
    assert.match(SRC, /console\.log\('\[session\] TOOL RESULT', ev\.tool, ev\.ok \? 'ok' : 'ERR', mirrorClip\(String\(ev\.summary \|\| ''\), \d+\)\)/);
    assert.match(SRC, /console\.log\('\[session\]', ev\.type, mirrorClip\(JSON\.stringify\(ev\), \d+\)\)/);
    assert.match(SRC, /console\.log\('\[session\] TOOL', ev\.tool, mirrorClip\(JSON\.stringify\(ev\.args \|\| \{\}\), \d+\)\)/);
  });

  it('detail-bearing events keep ≥600-char budgets', () => {
    const m = /console\.log\('\[session\]', ev\.type, mirrorClip\(JSON\.stringify\(ev\), (\d+)\)\)/.exec(SRC);
    assert.ok(m, 'generic event mirror line exists in wizard.js');
    assert.ok(parseInt(m[1], 10) >= 600, 'stopped/error/paused mirror budget >= 600');
  });
});
