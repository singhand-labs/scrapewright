// Graduated activation × evidence-first routing × step-plan continuity
// (spec docs/superpowers/specs/2026-09-18-graduated-activation-design.md).
//
// Task 1 (§3.A): lazy-load detection drives a three-tier activation policy:
//   - static page  → NO activation at all (background completion; the
//     visibility-keepalive layer already covers page-JS self-checks)
//   - lazy page    → current sticky activation + window-focus enforcement
//     (forty-ninth-log user authorization retained for the tier that needs it)
//   - hover tier   → tab activation WITHOUT window-focus steal on the first
//     attempt; a dispatch-failure receipt with a timeout/contention reason
//     escalates the SAME tab to window focus on the next attempt
//   - unknown profile (probe failed / legacy stubs) → conservative current
//     behavior — this is what keeps the RC20/RC56/49th-log tests green.
//
// Frame-starvation rollback: a background-completed op whose failure receipt
// shows pageState hidden/unfocused + ~0 rAF ticks upgrades the next request
// for the same tab (one retry is the cost of a wrong probe, not a lost run).

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

const TA_PATH = path.join(__dirname, '..', 'lib', 'tab-activation.js');
const CS_PATH = path.join(__dirname, '..', 'content-script.js');
const BG_PATH = path.join(__dirname, '..', 'background.js');

function sliceFunction(src, name) {
  const start = src.indexOf('function ' + name + '(');
  assert.ok(start !== -1, name + ' not found');
  let depth = 0, inString = null, bodyStart = -1, bodyEnd = -1;
  for (let i = start; i < src.length; i++) {
    const ch = src[i];
    if (inString) {
      if (ch === '\\') { i++; continue; }
      if (ch === inString) inString = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { inString = ch; continue; }
    if (ch === '{') { if (bodyStart === -1) bodyStart = i; depth++; }
    else if (ch === '}') { depth--; if (depth === 0) { bodyEnd = i; break; } }
  }
  assert.ok(bodyStart !== -1 && bodyEnd !== -1, 'could not slice ' + name);
  return src.slice(start, bodyEnd + 1);
}

function loadTabActivation() {
  const calls = { tabsGet: [], tabsUpdate: [], windowsGetLastFocused: [], windowsGet: [], windowsUpdate: [] };
  const tabsById = new Map();
  const windowsById = new Map();
  let focusedWindowId = 1;
  const removedListeners = [];
  const chromeMock = {
    tabs: {
      get: (tabId) => {
        calls.tabsGet.push(tabId);
        const tab = tabsById.get(tabId);
        if (!tab) return Promise.reject(new Error('No tab with id ' + tabId));
        return Promise.resolve(tab);
      },
      update: (tabId, props) => {
        calls.tabsUpdate.push({ tabId, props });
        const tab = tabsById.get(tabId);
        if (!tab) return Promise.reject(new Error('No tab with id ' + tabId));
        if (props && props.active === true) {
          for (const t of tabsById.values()) {
            if (t.windowId === tab.windowId && t.active) t.active = false;
          }
          tab.active = true;
        }
        return Promise.resolve(tab);
      },
      onActivated: { addListener: () => {} },
      onRemoved: { addListener: (fn) => removedListeners.push(fn) }
    },
    windows: {
      getLastFocused: () => {
        calls.windowsGetLastFocused.push(focusedWindowId);
        return Promise.resolve({ id: focusedWindowId });
      },
      get: (windowId) => {
        calls.windowsGet.push(windowId);
        const w = windowsById.get(windowId);
        if (!w) return Promise.reject(new Error('No window ' + windowId));
        return Promise.resolve(w);
      },
      update: (windowId, props) => {
        calls.windowsUpdate.push({ windowId, props });
        return Promise.resolve({ id: windowId });
      }
    },
    runtime: {}
  };
  const sandbox = {
    chrome: chromeMock,
    console: { log: () => {}, warn: () => {}, error: () => {} },
    setTimeout: () => 0, clearTimeout: () => {},
    module: { exports: {} }
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(TA_PATH, 'utf8'), sandbox, { filename: 'tab-activation.js' });
  return {
    api: sandbox.module.exports, calls, tabsById, windowsById, removedListeners,
    setFocusedWindow: (id) => { focusedWindowId = id; }
  };
}

// ---------------------------------------------------------------------------
// §3.A — pure tier decision

describe('graduated activation: decideActivation(profile, need)', () => {
  it('static page → no activation, reason "static page"', () => {
    const ctx = loadTabActivation();
    const d = ctx.api.decideActivation('static', 'frame');
    assert.equal(d.activate, false);
    assert.match(d.reason, /static page/);
  });

  it('lazy page + frame need → current behavior (sticky tab + window focus)', () => {
    const ctx = loadTabActivation();
    const d = ctx.api.decideActivation('lazy', 'frame');
    assert.equal(d.activate, true);
    assert.equal(d.focusWindow, true);
  });

  it('lazy page + hover need → tab activation WITHOUT window focus; escalation triggers listed', () => {
    const ctx = loadTabActivation();
    const d = ctx.api.decideActivation('lazy', 'hover');
    assert.equal(d.activate, true);
    assert.equal(d.focusWindow, false);
    assert.ok(Array.isArray(d.escalateOn) && d.escalateOn.indexOf('dispatch-timeout') !== -1,
      'escalateOn must name dispatch-timeout so the receipt matcher can key on it');
  });

  it('unknown profile (probe failed / legacy stub) → conservative current behavior', () => {
    const ctx = loadTabActivation();
    for (const need of ['frame', 'hover', undefined]) {
      const d = ctx.api.decideActivation(undefined, need);
      assert.equal(d.activate, true, 'need=' + need);
      assert.equal(d.focusWindow, true, 'unknown profile must keep the forty-ninth-log default');
    }
  });
});

// ---------------------------------------------------------------------------
// §3.A — requestActivation tiers

describe('graduated activation: requestActivation tiers', () => {
  it('static page → zero chrome.tabs.update / chrome.windows.update calls, skippedActivation receipt', async () => {
    const ctx = loadTabActivation();
    ctx.setFocusedWindow(2); // cross-window + hidden evidence would normally raise the window
    ctx.tabsById.set(101, { id: 101, windowId: 1, active: false });
    const r = await ctx.api.requestActivation(101, { pageProfile: 'static', need: 'frame', forceWindowFocus: true });
    assert.equal(r.ok, true);
    assert.equal(r.activated, false);
    assert.equal(r.skippedActivation, true);
    assert.match(r.reason, /static page/);
    assert.equal(ctx.calls.tabsUpdate.length, 0, 'static page: background completion, no focus steal');
    assert.equal(ctx.calls.windowsUpdate.length, 0);
  });

  it('lazy page + hover: tab activated but window focus NOT stolen on the first attempt', async () => {
    const ctx = loadTabActivation();
    ctx.setFocusedWindow(2); // scrape window is not the focused one
    ctx.tabsById.set(101, { id: 101, windowId: 1, active: false });
    ctx.windowsById.set(1, { id: 1, state: 'normal' });
    const r = await ctx.api.requestActivation(101, { pageProfile: 'lazy', need: 'hover', forceWindowFocus: true });
    assert.equal(r.ok, true);
    assert.equal(r.activated, true, 'CDP input needs the active tab');
    assert.equal(ctx.calls.tabsUpdate.length, 1);
    assert.equal(ctx.calls.windowsUpdate.length, 0, 'first hover attempt: window focus degraded, user keeps their focus');
    assert.notEqual(r.focusedWindow, true);
  });

  it('hover dispatch failure (timeout reason) escalates the SAME tab to window focus on the next attempt', async () => {
    const ctx = loadTabActivation();
    ctx.setFocusedWindow(2);
    ctx.tabsById.set(101, { id: 101, windowId: 1, active: false });
    ctx.windowsById.set(1, { id: 1, state: 'normal' });
    ctx.api.noteHoverDispatchFailure(101, 'hover dispatch failed: hover.mouseMoved timeout');
    const r = await ctx.api.requestActivation(101, { pageProfile: 'lazy', need: 'hover' });
    assert.equal(r.ok, true);
    assert.equal(r.upgradedActivation, true, 'escalation must be disclosed in the receipt');
    assert.equal(ctx.calls.tabsUpdate.length, 1);
    assert.equal(ctx.calls.windowsUpdate.length, 1, 'second attempt raises the window');
  });

  it('deterministic gate failure ("enhanced mode disabled") does NOT escalate', async () => {
    const ctx = loadTabActivation();
    ctx.setFocusedWindow(2);
    ctx.tabsById.set(101, { id: 101, windowId: 1, active: false });
    ctx.windowsById.set(1, { id: 1, state: 'normal' });
    ctx.api.noteHoverDispatchFailure(101, 'enhanced mode disabled');
    const r = await ctx.api.requestActivation(101, { pageProfile: 'lazy', need: 'hover' });
    assert.equal(r.ok, true);
    assert.notEqual(r.upgradedActivation, true, 'a capability gate is not a frame-starvation signal');
    assert.equal(ctx.calls.windowsUpdate.length, 0);
  });

  it('frame-starvation upgrade flag overrides the static-page skip (rollback: probe errors cost one retry)', async () => {
    const ctx = loadTabActivation();
    ctx.setFocusedWindow(2);
    ctx.tabsById.set(101, { id: 101, windowId: 1, active: false });
    ctx.windowsById.set(1, { id: 1, state: 'normal' });
    const r = await ctx.api.requestActivation(101, { pageProfile: 'static', need: 'frame', upgrade: true });
    assert.equal(r.ok, true);
    assert.notEqual(r.skippedActivation, true, 'frame starvation overrides the static-page skip');
    assert.equal(r.upgradedActivation, true);
    assert.equal(ctx.calls.tabsUpdate.length, 1, 'the op runs as if the page were lazy');
    assert.equal(ctx.calls.windowsUpdate.length, 1, 'frame starvation re-earns the forty-ninth-log authorization');
  });

  it('unknown profile keeps current behavior exactly (control for RC20/RC56/49th-log stubs)', async () => {
    const ctx = loadTabActivation();
    ctx.setFocusedWindow(2);
    ctx.tabsById.set(101, { id: 101, windowId: 1, active: false });
    ctx.windowsById.set(1, { id: 1, state: 'normal' });
    const r = await ctx.api.requestActivation(101, { forceWindowFocus: true });
    assert.equal(r.ok, true);
    assert.equal(r.activated, true);
    assert.equal(r.focusedWindow, true);
    assert.equal(ctx.calls.tabsUpdate.length, 1);
    assert.equal(ctx.calls.windowsUpdate.length, 1);
  });
});

// ---------------------------------------------------------------------------
// §3.A — content-script wiring (source-text audit; domHover runs in-page so
// unit tests cannot exercise it directly — same pattern as the RC50 audit)

describe('graduated activation: content-script wiring', () => {
  const src = fs.readFileSync(CS_PATH, 'utf8');

  it('detectLazyLoadProfile exists and caches its result for the tab lifetime', () => {
    const fn = sliceFunction(src, 'detectLazyLoadProfile');
    assert.match(fn, /__scrapewrightPageProfile/, 'result cached once per tab');
    assert.match(fn, /MutationObserver/, 'mutation-count signal is part of the probe');
  });

  it('withTabActivation probes the profile BEFORE sending, and the payload carries pageProfile + need', () => {
    const fn = sliceFunction(src, 'withTabActivation');
    const sendIdx = fn.indexOf("type: 'TAB_ACTIVATION_REQUEST'");
    assert.ok(sendIdx > -1, 'TAB_ACTIVATION_REQUEST send exists');
    assert.match(fn.slice(0, sendIdx), /getPageProfile|detectLazyLoadProfile/,
      'the probe runs before the activation request is sent (the probe itself must not activate)');
    const payload = fn.slice(sendIdx, sendIdx + 400);
    assert.match(payload, /pageProfile/, 'payload carries the measured profile');
    assert.match(payload, /need/, 'payload carries the tier need');
  });

  it('hover and dismiss call sites pass the hover tier need', () => {
    for (const label of ['hover', 'hoverDismiss']) {
      const re = new RegExp("withTabActivation\\(['\"]" + label + "['\"]");
      const m = src.match(re);
      assert.ok(m, label + ' wrap site exists');
      // The opts object lands AFTER the wrapped async body — scan the whole
      // wrap span and require the trusted message inside it too, so a
      // different site's need cannot satisfy the assertion.
      const at = src.indexOf(m[0]);
      const span = src.slice(at, at + 4000);
      assert.ok(span.indexOf('TRUSTED_HOVER') !== -1, label + ' wrap span must contain the trusted dispatch');
      assert.match(span, /need:\s*['"]hover['"]/,
        label + ' must request the hover tier (window focus degraded on first attempt)');
    }
  });

  it('scroll ops keep the default frame tier (no need: argument needed)', () => {
    for (const label of ['scrollBy', 'scrollToBottom', 'scrollIntoView', 'waitForStable', 'clickInList']) {
      assert.ok(src.indexOf("withTabActivation('" + label + "'") !== -1, label + ' wrap site exists');
    }
  });

  it('frame-starvation evidence sets the upgrade flag for the next request', () => {
    const fn = sliceFunction(src, 'attachScrollEvidence');
    assert.match(fn, /__scrapewrightFrameStarved/,
      'gated pageState + ~0 rAF ticks must mark the tab so the NEXT activation upgrades one tier');
  });
});

describe('graduated activation: background wiring (source-text audit)', () => {
  const src = fs.readFileSync(BG_PATH, 'utf8');

  it('TAB_ACTIVATION_REQUEST handler forwards pageProfile + need + upgrade', () => {
    const at = src.indexOf("message.type === 'TAB_ACTIVATION_REQUEST'");
    assert.ok(at > -1);
    const body = src.slice(at, at + 2000);
    assert.match(body, /pageProfile/);
    assert.match(body, /need/);
    assert.match(body, /upgrade/, 'frame-starved rollback flag must reach requestActivation');
  });

  it('TRUSTED_HOVER_REQUEST handler records dispatch failures for escalation', () => {
    const at = src.indexOf("message.type === 'TRUSTED_HOVER_REQUEST'");
    assert.ok(at > -1);
    const body = src.slice(at, src.indexOf('TRUSTED_HOVER_DISMISS', at));
    assert.match(body, /noteHoverDispatchFailure/,
      'a dispatched:false receipt must feed the escalation ledger');
  });
});

// ---------------------------------------------------------------------------
// §3.A — detection probe behavior (JSDOM)

describe('graduated activation: detectLazyLoadProfile probe', () => {
  function runProbe(dom, opts) {
    const sandbox = {
      document: dom.window.document,
      window: dom.window,
      MutationObserver: dom.window.MutationObserver,
      setTimeout: (fn) => { fn(); return 0; },   // collapse the probe's pacing
      clearTimeout: () => {}
    };
    vm.createContext(sandbox);
    const src = fs.readFileSync(CS_PATH, 'utf8');
    vm.runInContext(sliceFunction(src, 'detectLazyLoadProfile'), sandbox, { filename: 'detect.js' });
    return sandbox.detectLazyLoadProfile(opts);
  }

  it('no height growth, quiet DOM → static', async () => {
    const dom = new JSDOM('<html><body><div>content</div></body></html>', { url: 'https://example.com/p' });
    const profile = await runProbe(dom);
    assert.equal(profile, 'static');
  });

  it('page-height growth >5% across the probe scrolls → lazy', async () => {
    const dom = new JSDOM('<html><body><div>feed</div></body></html>', { url: 'https://example.com/p' });
    let reads = 0;
    Object.defineProperty(dom.window.document.documentElement, 'scrollHeight', {
      configurable: true,
      get() { reads++; return 1000 + 60 * reads; } // 3 reads → ~18% growth
    });
    const profile = await runProbe(dom);
    assert.equal(profile, 'lazy');
  });
});

// ---------------------------------------------------------------------------
// §3.B — evidence-first routing (knowledge unit + verify tail sentence)

const KNOWLEDGE_UNITS_SRC = fs.readFileSync(path.join(__dirname, '..', 'lib', 'knowledge-units.js'), 'utf8');

describe('evidence-first routing: no-evidence-no-conclusion knowledge unit', () => {
  it('unit exists with in-vocabulary matchEvents', () => {
    const at = KNOWLEDGE_UNITS_SRC.indexOf("id: 'no-evidence-no-conclusion'");
    assert.ok(at > -1, 'no-evidence-no-conclusion unit must exist');
    const m = KNOWLEDGE_UNITS_SRC.slice(at, at + 1200).match(/matchEvents:\s*\[([^\]]*)\]/);
    assert.ok(m, 'matchEvents array found');
    const events = m[1].split(',').map((s) => s.trim().replace(/['"]/g, '')).filter(Boolean);
    assert.ok(events.length >= 5, 'unit must route on the guessing-moment tags, got: ' + JSON.stringify(events));
    for (const required of ['FIELD_MATCH_ZERO', 'REQUIRED_FIELD_EMPTY', 'STAGNANT_DISCLOSURES', 'SELECTOR_ZERO_MATCH', 'HOVER_NO_SIGNAL']) {
      assert.ok(events.indexOf(required) !== -1, 'matchEvents must include ' + required);
    }
  });

  it('body carries the three-exit teaching + the evidence actions (probe.skeleton / user.observe)', () => {
    const at = KNOWLEDGE_UNITS_SRC.indexOf("id: 'no-evidence-no-conclusion'");
    const body = KNOWLEDGE_UNITS_SRC.slice(at, at + 4000);
    assert.match(body, /probe\.skeleton|probe\.sample/, 're-fetch fragment action');
    assert.match(body, /user\.observe/, 'human-sensor action');
    assert.match(body, /probe\.hover/, 'popover behavior must be proven by one probe.hover');
    assert.match(body, /io\.confirm/, 'renegotiate exit must be named');
  });

  it('universality guard — no site tokens in the new strings', () => {
    const FORBIDDEN = /facebook|twitter|linkedin|tiktok|reddit|\bfb\b/i;
    const at = KNOWLEDGE_UNITS_SRC.indexOf("id: 'no-evidence-no-conclusion'");
    const unit = KNOWLEDGE_UNITS_SRC.slice(at, at + 4000);
    assert.ok(!FORBIDDEN.test(unit), 'knowledge unit body must be site-agnostic');
    const self = fs.readFileSync(__filename, 'utf8').replace(/const FORBIDDEN = [^\n]*;/, '');
    assert.ok(!FORBIDDEN.test(self), 'this test file must stay site-agnostic too');
  });
});

describe('evidence-first routing: REQUIRED_FIELD_EMPTY evidence-action tail', () => {
  const vsrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'verify-runner.js'), 'utf8');

  it('message carries the re-fetch-one-record evidence action', () => {
    const at = vsrc.indexOf('REQUIRED_FIELD_EMPTY: ');
    assert.ok(at > -1);
    const msg = vsrc.slice(at, at + 3000);
    assert.match(msg, /re-fetch ONE failing record\\?'s fragment/, 'evidence action must be concrete');
    assert.match(msg, /probe\.skeleton/, 'names the tool');
    assert.match(msg, /user\.observe/, 'names the human-sensor exit');
    assert.match(msg, /probe\.snippt|probe\.snippet/, 'snippet dry-run teaching survives the merge');
  });

  it('single tail — the old generic sentence is not duplicated', () => {
    const at = vsrc.indexOf('REQUIRED_FIELD_EMPTY: ');
    const msg = vsrc.slice(at, at + 3000);
    assert.equal((msg.match(/re-fetch ONE failing record/g) || []).length, 1, 'exactly one evidence-action tail');
  });
});

// ---------------------------------------------------------------------------
// §3.C — step-plan continuity (state.stepPlan + dossier [STEP PLAN] section)

const Dossier = require(path.join(__dirname, '..', 'lib', 'evidence-dossier.js'));
const { createResearchSession } = require(path.join(__dirname, '..', 'lib', 'research-session.js'));

function scriptedLlm(replies, calls) {
  let i = 0;
  return async (req) => {
    calls.push(req);
    const r = replies[Math.min(i, replies.length - 1)];
    i++;
    return r;
  };
}
function reply(content) { return { content, finish_reason: 'stop', usage: { prompt_tokens: 100, completion_tokens: 10 } }; }
function envelope(tool, args) { return JSON.stringify({ think: 't', tool, args: args || {} }); }
function finishEnvelope(s) { return JSON.stringify({ think: 'done', finish: { summary: s || 'done' } }); }

describe('step plan: buildDossier [STEP PLAN] section', () => {
  it('renders one line per step + the fixed teaching line when stepPlan is provided', () => {
    const text = Dossier.buildDossier({
      stepPlan: [
        { stepId: 's1', name: 'extract cards', status: 'grounded', note: 'probe.count' },
        { stepId: 's2', name: 'hover time', status: 'planned', note: '' }
      ]
    });
    assert.match(text, /\[STEP PLAN\]/);
    assert.match(text, /s1 \(extract cards\): grounded — probe\.count/);
    assert.match(text, /s2 \(hover time\): planned/);
    assert.match(text, /research the FIRST non-grounded step; re-probe grounded steps only when their selector family fails in verify/);
  });

  it('no [STEP PLAN] section when the plan is empty/absent (pre-artifact sessions)', () => {
    const text = Dossier.buildDossier({});
    assert.ok(!/\[STEP PLAN\]/.test(text));
  });
});

describe('step plan: engine lifecycle (spec §3.C)', () => {
  function makeSession(replies, calls, tools) {
    return createResearchSession({
      requirement: 'r',
      llm: scriptedLlm(replies, calls),
      tools: tools,
      dossierFeeds: { containerHtml: () => null, popovers: () => [], lastVerify: () => null }
    });
  }

  it('service.update rebuilds the plan (planned); probe receipt grounds; verify marks tested', async () => {
    const calls = [];
    const script1 = "return await $extractList('div.card', { title: { selector: 'h3' } })";
    const session = makeSession([
      reply(envelope('probe.count', { sel: 'div.card' })),
      reply(envelope('service.update', { steps: [{ id: 's1', name: 'extract cards', script: script1 }] })),
      reply(envelope('verify.run', {})),
      reply(finishEnvelope())
    ], calls, {
      'probe.count': async () => ({ count: 5 }),
      'verify.run': async () => ({ ok: true, steps: [{ stepId: 's1', result: { posts: [1, 2] } }] })
    });
    await session.run();
    const lastDossier = calls[calls.length - 1].messages
      .filter((m) => m.role === 'system' && m.content.includes('EVIDENCE DOSSIER'))[0].content;
    assert.match(lastDossier, /\[STEP PLAN\]/, 'section rides the dossier');
    assert.match(lastDossier, /s1 \(extract cards\): tested/, 'verify success → tested');
  });

  it('probe grounding marks grounded before any verify; verify failure marks failed', async () => {
    const calls = [];
    const script1 = "return await $extractList('div.row', { title: { selector: 'h3' } })";
    const session = makeSession([
      reply(envelope('probe.count', { sel: 'div.row' })),
      reply(envelope('service.update', { steps: [{ id: 's1', name: 'x', script: script1 }] })),
      reply(envelope('probe.count', { sel: 'div.row' })),
      reply(envelope('verify.run', {})),
      reply(finishEnvelope())
    ], calls, {
      'probe.count': async () => ({ count: 3 }),
      'verify.run': async () => ({ ok: false, error: { message: 'boom' }, steps: [{ stepId: 's1', error: 'ELEMENT_NOT_FOUND' }] })
    });
    await session.run();
    const dossiers = calls.map((c) => c.messages
      .filter((m) => m.role === 'system' && m.content.includes('EVIDENCE DOSSIER'))[0].content);
    const afterProbe = dossiers[3]; // turn following the post-update probe.count
    assert.match(afterProbe, /s1 \(x\): grounded — probe\.count/, 'probe receipt on a selector in the step script → grounded');
    const last = dossiers[dossiers.length - 1];
    assert.match(last, /s1 \(x\): failed/, 'verify step failure → failed');
  });

  it('rebuild preserves same-stepId status/note; new steps start planned', async () => {
    const calls = [];
    const s1 = "return await $extractList('div.k', { title: { selector: 'h3' } })";
    const session = makeSession([
      reply(envelope('probe.count', { sel: 'div.k' })),
      reply(envelope('service.update', { steps: [{ id: 's1', name: 'one', script: s1 }] })),
      reply(envelope('probe.count', { sel: 'div.k' })),
      reply(envelope('service.update', { steps: [
        { id: 's1', name: 'one', script: s1 },
        { id: 's2', name: 'two', script: "return await $count('div.k')" }
      ] })),
      reply(finishEnvelope())
    ], calls, { 'probe.count': async () => ({ count: 2 }) });
    await session.run();
    const lastDossier = calls[calls.length - 1].messages
      .filter((m) => m.role === 'system' && m.content.includes('EVIDENCE DOSSIER'))[0].content;
    assert.match(lastDossier, /s1 \(one\): grounded/, 'surviving step keeps its status across the rebuild');
    assert.match(lastDossier, /s2 \(two\): planned/, 'new step starts planned');
  });
});
