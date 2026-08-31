// Regression for the ~5000-char silent line cut in the captured SW console
// log (third- and fourth-session logs): debug-logger.js stringifies payloads
// fully, but Chrome DevTools truncates console string arguments at ~5000
// chars with NO marker — the fourth-session testScript success line lost
// posts 2..5 of finalResult mid-JSON, and the third-session postHtml had to
// be hand-recovered from the amputated head. The fix: debug-logger now cuts
// FIRST with a head+tail split and the original length disclosed.

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { DebugLogger } = require('../lib/debug-logger');

const origLog = console.log, origWarn = console.warn, origError = console.error;
let calls;

describe('DebugLogger console-line truncation', () => {
  beforeEach(() => {
    calls = { log: [], warn: [], error: [] };
    console.log = (...a) => calls.log.push(a);
    console.warn = (...a) => calls.warn.push(a);
    console.error = (...a) => calls.error.push(a);
  });
  afterEach(() => {
    console.log = origLog; console.warn = origWarn; console.error = origError;
  });

  it('short payloads pass through untouched (exact string)', () => {
    const l = new DebugLogger();
    l.log('info', 'wizard', 'Script executed', { done: true });
    assert.equal(calls.log.length, 1);
    const [prefix, suffix] = calls.log[0];
    assert.match(prefix, /\[wizard\] Script executed$/);
    assert.equal(suffix, '{"done":true}');
  });

  it('long payloads: head+tail kept, original length disclosed, under DevTools cut', () => {
    const l = new DebugLogger();
    // Fourth-session shape: finalResult with 5 posts, cut lived inside post 1.
    const payload = { finalResult: { posts: Array.from({ length: 5 }, (_, i) =>
      ({ n: i + 1, body: 'x'.repeat(2000) })) } };
    l.log('info', 'wizard', 'testScript success', payload);
    assert.equal(calls.log.length, 1);
    const [prefix, suffix] = calls.log[0];
    // Whole line (prefix + space + suffix) must stay under DevTools' ~5000 cut.
    assert.ok(prefix.length + 1 + suffix.length < 5000,
      'total line under 5000, got ' + (prefix.length + 1 + suffix.length));
    // Cut is DISCLOSED with the original length.
    assert.match(suffix, /console log truncated; original \d+ chars, middle cut/);
    const m = suffix.match(/original (\d+) chars/);
    assert.ok(Number(m[1]) > 10000, 'disclosed original length is the full size');
    // Both ends survive: head (posts array start) and tail (last post body + closing braces).
    assert.match(suffix, /^\{"finalResult":\{"posts":\[\{"n":1/);
    assert.match(suffix, /x+"\}\]\}\}$/, 'tail end of the JSON kept');
  });

  it('string data payloads get the same treatment', () => {
    const l = new DebugLogger();
    const long = 'HEAD_MARKER' + 'y'.repeat(9000) + 'TAIL_MARKER';
    l.log('warn', 'content-script', 'big html', long);
    const suffix = calls.warn[0][1];
    assert.match(suffix, /HEAD_MARKER/);
    assert.match(suffix, /TAIL_MARKER/);
    assert.match(suffix, /original 9022 chars/);
  });

  it('level routing preserved (error → console.error, truncated too)', () => {
    const l = new DebugLogger();
    l.log('error', 'step-orchestrator', 'Script execution failed',
      { error: 'E'.repeat(8000) });
    assert.equal(calls.error.length, 1);
    assert.equal(calls.log.length, 0);
    const suffix = calls.error[0][1];
    assert.match(suffix, /console log truncated/);
  });

  it('null data still logs an empty suffix without truncation logic firing', () => {
    const l = new DebugLogger();
    l.log('info', 'wizard', 'testScript start');
    assert.equal(calls.log[0][1], '');
  });
});
