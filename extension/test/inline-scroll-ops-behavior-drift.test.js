// B1 behavior diff: run lib/scroll-ops.js and content-script.js's inline
// fallback over the SAME scripted fake roots and assert deep-equal outputs.
// The key-parity guard (inline-scroll-ops-drift.test.js) missed the RC21
// dual-signal stall detection entirely — the inline copy stalled on the
// count signal with MAX_ATTEMPTS=8 while the lib waited out stallWindowMs
// with 15. Constants drift is invisible to name checks; behavior is not.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const libOps = require('../lib/scroll-ops');
const CONTENT_SCRIPT_PATH = path.join(__dirname, '..', 'content-script.js');

function sliceFunctionBody(source, fnName) {
  const fnStart = source.indexOf('function ' + fnName);
  assert.ok(fnStart !== -1, 'content-script.js: ' + fnName + ' not found');
  let depth = 0;
  let inString = null;
  let fnBodyStart = -1;
  let fnEnd = -1;
  for (let i = fnStart; i < source.length; i++) {
    const ch = source[i];
    const next = source[i + 1];
    if (inString) {
      if (ch === '\\') { i++; continue; }
      if (ch === inString) inString = null;
      continue;
    }
    if (ch === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i++;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { inString = ch; continue; }
    if (ch === '{') {
      if (depth === 0) fnBodyStart = i + 1;
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) { fnEnd = i; break; }
    }
  }
  assert.ok(fnEnd !== -1, 'content-script.js: ' + fnName + ' body never closes');
  return source.slice(fnBodyStart, fnEnd);
}

function loadInlineScrollOps() {
  const csSrc = fs.readFileSync(CONTENT_SCRIPT_PATH, 'utf8');
  const body = sliceFunctionBody(csSrc, 'createInlineScrollOps');
  const factory = new Function('window', body + '\n' +
    'return {\n' +
    '  scrollToBottomIncremental: scrollToBottomIncremental,\n' +
    '  DEFAULT_MAX_ATTEMPTS: DEFAULT_MAX_ATTEMPTS,\n' +
    '  DEFAULT_NO_PROGRESS_LIMIT: DEFAULT_NO_PROGRESS_LIMIT,\n' +
    '  DEFAULT_SETTLE_MS: DEFAULT_SETTLE_MS,\n' +
    '  DEFAULT_STALL_WINDOW_MS: DEFAULT_STALL_WINDOW_MS,\n' +
    '  DEFAULT_MAX_TRUSTED_WHEEL_ATTEMPTS: DEFAULT_MAX_TRUSTED_WHEEL_ATTEMPTS,\n' +
    '  SCROLL_INCREMENT_RATIO: SCROLL_INCREMENT_RATIO\n' +
    '};');
  return factory({ innerHeight: 800 });
}

// ---- fake roots (twins: one fresh instance per side) ----

function makeGrowingRoot() {
  let scrollTop = 0;
  let scrollHeight = 1000;
  return {
    get scrollTop() { return scrollTop; },
    set scrollTop(v) { scrollTop = v; },
    get scrollHeight() { return scrollHeight; },
    clientHeight: 500,
    scrollBy(dx, dy) { scrollHeight += 700; scrollTop = Math.max(0, Math.min(scrollTop + dy, scrollHeight - 500)); },
    scrollTo(x, y) { scrollTop = y; }
  };
}

function makeStalledRoot() {
  return {
    scrollTop: 0,
    scrollHeight: 5000,
    clientHeight: 500,
    scrollBy() { /* no-op — nothing moves, nothing grows */ },
    scrollTo() {}
  };
}

function makeMovingNoGrowRoot() {
  let scrollTop = 0;
  const scrollHeight = 10000;
  return {
    get scrollTop() { return scrollTop; },
    set scrollTop(v) { scrollTop = v; },
    get scrollHeight() { return scrollHeight; },
    clientHeight: 500,
    scrollBy(dx, dy) { scrollTop = Math.max(0, Math.min(scrollTop + dy, scrollHeight - 500)); },
    scrollTo(x, y) { scrollTop = y; }
  };
}

function makeNoOverflowRoot() {
  return { scrollTop: 0, scrollHeight: 500, clientHeight: 500, scrollBy() {}, scrollTo() {} };
}

// Runs both implementations over twin roots with a shared fake clock that
// advances inside the sleep stub (mirrors wall-clock passing during settle).
async function runBoth(makeRoot, extraOpts) {
  const out = {};
  for (const side of ['lib', 'inline']) {
    let t = 1000;
    const sleep = (ms) => { t += ms; return Promise.resolve(); };
    const now = () => t;
    const iters = [];
    const fn = side === 'lib' ? libOps.scrollToBottomIncremental : loadInlineScrollOps().scrollToBottomIncremental;
    out[side] = await fn(makeRoot(), Object.assign({ sleep, now, onIter: (r) => iters.push(r) }, extraOpts || {}));
    out[side + 'Iters'] = iters;
  }
  return out;
}

describe('inline ScrollOps behavior diff (B1)', () => {
  it('constants agree, at the RC21 values', () => {
    const inline = loadInlineScrollOps();
    assert.equal(inline.DEFAULT_MAX_ATTEMPTS, libOps.DEFAULT_MAX_ATTEMPTS);
    assert.equal(inline.DEFAULT_MAX_ATTEMPTS, 15);
    assert.equal(inline.DEFAULT_STALL_WINDOW_MS, libOps.DEFAULT_STALL_WINDOW_MS);
    assert.equal(inline.DEFAULT_STALL_WINDOW_MS, 3000);
    assert.equal(inline.DEFAULT_NO_PROGRESS_LIMIT, libOps.DEFAULT_NO_PROGRESS_LIMIT);
    assert.equal(inline.DEFAULT_SETTLE_MS, libOps.DEFAULT_SETTLE_MS);
    assert.equal(inline.DEFAULT_MAX_TRUSTED_WHEEL_ATTEMPTS, libOps.DEFAULT_MAX_TRUSTED_WHEEL_ATTEMPTS);
    assert.equal(inline.SCROLL_INCREMENT_RATIO, libOps.SCROLL_INCREMENT_RATIO);
  });

  it('growing content: identical results + iteration reports', async () => {
    const r = await runBoth(makeGrowingRoot, { maxAttempts: 5 });
    assert.deepEqual(r.inline, r.lib);
    assert.deepEqual(r.inlineIters, r.libIters);
    assert.equal(r.lib.stalled, false);
  });

  it('fully stalled root: identical count-based stall (reason + attempts)', async () => {
    const r = await runBoth(makeStalledRoot);
    assert.deepEqual(r.inline, r.lib);
    assert.deepEqual(r.inlineIters, r.libIters);
    assert.equal(r.lib.stalled, true);
    assert.equal(r.lib.stallReason, 'no_progress_count_elapsed');
    assert.equal(r.lib.attempts, 3);
  });

  it('RC21 time-stall: position moves but height never grows — both stop on stall_window_elapsed with identical attempts', async () => {
    const r = await runBoth(makeMovingNoGrowRoot);
    assert.deepEqual(r.inline, r.lib);
    assert.deepEqual(r.inlineIters, r.libIters);
    assert.equal(r.lib.stalled, true);
    assert.equal(r.lib.stallReason, 'stall_window_elapsed');
    assert.equal(r.lib.attempts, 9, '3000ms window / 350ms settle');
  });

  it('no-overflow root: identical early-exit shape (stallReason no_overflow + stallWindowMs)', async () => {
    const r = await runBoth(makeNoOverflowRoot);
    assert.deepEqual(r.inline, r.lib);
    assert.equal(r.lib.noOverflow, true);
    assert.equal(r.lib.stallReason, 'no_overflow');
    assert.equal(r.lib.stallWindowMs, 3000);
    assert.deepEqual(r.inlineIters, r.libIters);
  });

  it('trusted-wheel dispatch: identical recovery accounting', async () => {
    const outcomes = {};
    for (const side of ['lib', 'inline']) {
      let t = 1000;
      const sleep = (ms) => { t += ms; return Promise.resolve(); };
      const now = () => t;
      const iters = [];
      let theRoot = null;
      const fallback = async () => {
        // simulate the trusted wheel triggering lazy-load: content now grows on scroll
        root.activate();
        return { dispatched: true };
      };
      const fn = side === 'lib' ? libOps.scrollToBottomIncremental : loadInlineScrollOps().scrollToBottomIncremental;
      const root = (function () {
        let scrollTop = 0;
        let scrollHeight = 5000;
        let fertile = false;
        const r = {
          get scrollTop() { return scrollTop; },
          set scrollTop(v) { scrollTop = v; },
          get scrollHeight() { return scrollHeight; },
          clientHeight: 500,
          scrollBy(dx, dy) {
            if (!fertile) return; // stalled until the wheel activates lazy-load
            scrollHeight += 800;
            scrollTop = Math.max(0, Math.min(scrollTop + dy, scrollHeight - 500));
          },
          scrollTo() {},
          activate() { fertile = true; }
        };
        return r;
      })();
      theRoot = root;
      outcomes[side] = await fn(root, { sleep, now, onIter: (x) => iters.push(x), trustedWheelFallback: fallback });
      outcomes[side + 'Iters'] = iters;
    }
    assert.deepEqual(outcomes.inline, outcomes.lib);
    assert.deepEqual(outcomes.inlineIters, outcomes.libIters);
    assert.equal(outcomes.lib.trustedWheelAttempts, 1);
    assert.equal(outcomes.lib.stalled, false, 'growth after the wheel resets both stall signals');
  });
});
