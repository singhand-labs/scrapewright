// Twenty-third log RC-C raised the stopped-event mirror from 200 to 600
// chars — but the slice stayed head-only. Twenty-sixth log: BOTH stopped
// events of the session were cut mid-sentence at char ~600 with no
// truncation marker, and the honest-ship disclosure suffix
// ("[VERIFY PARTIAL-EMPTY — ...]") is APPENDED TO THE TAIL of the detail —
// so in exported console logs the disclosure is systematically invisible
// exactly when it matters. mirrorClip keeps head AND tail with an explicit
// elision marker.

const { describe, it, beforeEach, afterEach } = require('node:test');
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
  it('small status events route through mirrorClip, not a bare head slice', () => {
    assert.match(SRC, /console\.log\('\[session\]', ev\.type, mirrorClip\(JSON\.stringify\(ev\), \d+\)\)/);
    assert.match(SRC, /console\.log\('\[session\] TOOL RESULT', ev\.tool, ev\.ok \? 'ok' : 'ERR', mirrorClip\(String\(ev\.summary \|\| ''\), \d+\)\)/);
  });

  it('detail-bearing events keep ≥600-char budgets', () => {
    const m = /console\.log\('\[session\]', ev\.type, mirrorClip\(JSON\.stringify\(ev\), (\d+)\)\)/.exec(SRC);
    assert.ok(m, 'generic event mirror line exists in wizard.js');
    assert.ok(parseInt(m[1], 10) >= 600, 'stopped/error/paused mirror budget >= 600');
  });
});

// Thirty-second log (user directive): "console 日志如果一次输出不全，就分多次"
// — payload-bearing mirrors (TOOL args, TOOL RESULT detail) must CHUNK across
// multiple console lines instead of truncating: the exported log is the
// debugging lifeline.
describe('mirrorLines (thirty-second log: chunk, never clip, payload mirrors)', () => {
  const mirrorLines = eval('(function () { return (' + sliceFn('mirrorLines') + '); })()');
  const originalLog = console.log;
  let lines;
  beforeEach(() => { lines = []; console.log = (...a) => lines.push(a); });
  afterEach(() => { console.log = originalLog; });

  it('a short payload logs as one line', () => {
    mirrorLines('LBL', '{"steps":[]}', 8000);
    assert.equal(lines.length, 1);
    assert.equal(lines[0][0], 'LBL');
    assert.equal(lines[0][1], '{"steps":[]}');
  });

  it('a long payload splits into (i/N) parts that concatenate to the whole', () => {
    const payload = JSON.stringify({ steps: Array.from({ length: 200 }, (_, i) => ({ id: 's' + i, script: 'x'.repeat(80) })) });
    mirrorLines('[session] TOOL service.update', payload, 8000);
    assert.ok(lines.length >= 6, 'multiple chunk lines, got ' + lines.length);
    assert.match(lines[0][0], /\(1\/(\d+)\)$/);
    const n = parseInt(/\(1\/(\d+)\)/.exec(lines[0][0])[1], 10);
    assert.equal(lines.length, n + 1, 'exactly N parts plus the tail-elision disclosure');
    const reassembled = lines.slice(0, n).map((l) => l[1]).join('');
    assert.equal(reassembled, payload.slice(0, 8000), 'chunks concatenate losslessly up to the cap');
  });

  it('beyond the cap the elision is disclosed with a count', () => {
    const payload = 'y'.repeat(20000);
    mirrorLines('LBL', payload, 8000);
    const last = lines[lines.length - 1];
    assert.equal(last[0], 'LBL (tail elided)');
    assert.match(last[1], /\[\+12000 chars not shown\]/);
  });
});

describe('wizard.js payload mirrors use mirrorLines (source audit)', () => {
  it('TOOL args chunk-log at a generous cap, not the old 1200 clip', () => {
    assert.match(SRC, /mirrorLines\('\[session\] TOOL ' \+ ev\.tool, JSON\.stringify\(ev\.args \|\| \{\}\), (\d+)\)/);
    const cap = parseInt(/mirrorLines\('\[session\] TOOL ' \+ ev\.tool, JSON\.stringify\(ev\.args \|\| \{\}\), (\d+)\)/.exec(SRC)[1], 10);
    assert.ok(cap >= 8000, 'args budget generous enough to carry full step scripts');
  });

  it('TOOL RESULT detail chunk-logs when the engine attached one', () => {
    assert.match(SRC, /if \(ev\.detail\) mirrorLines\('\[session\] TOOL RESULT DETAIL ' \+ ev\.tool, ev\.detail, (\d+)\)/);
    const cap = parseInt(/if \(ev\.detail\) mirrorLines\('\[session\] TOOL RESULT DETAIL ' \+ ev\.tool, ev\.detail, (\d+)\)/.exec(SRC)[1], 10);
    assert.ok(cap >= 12000, 'detail budget matches the engine eventDetailCapChars');
  });
});
