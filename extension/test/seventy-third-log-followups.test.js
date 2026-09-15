// Seventy-third log follow-up (live feedback continuation): records #3-5
// postTime empty — deep-feed cold-mounted cards (data-virtualized contexts)
// whose aria-labelledby reference chains are not yet hydrated at read time.
// The step read via $labelledby, which resolved ONCE after finding the
// element; the 44th-log post-batch re-read covers only $extractWithHover-
// labelledby fields. Fix: domLabelledby now RETRIES the resolution on a
// bounded deadline — the SAME timeoutMs budget shared between element-wait
// and resolution retries (one deadline, never doubled). Retry only when the
// chain is present but unresolvable (refCount>0 with empty text, or
// missingIds); an absent attribute is structural and stays single-shot.
// probe.labelledby composes the same DSL call, so it inherits automatically
// (envelope parity pinned by labelledby-envelope-parity.test.js).

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

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

const RESOLVE_SRC =
  sliceFn(readSrc('content-script.js'), 'function resolveLabelledbyText(', '\n  async function domLabelledby');

function sliceDomLabelledby(src) {
  return sliceFn(src, 'async function domLabelledby(', '  // Sixty-fifth log: the step-side timestamp primitive');
}

function makeCtx(dom, anchor, onTimeout) {
  const ctx = {
    document: dom.window.document,
    Date: Date,
    setTimeout: (fn, ms) => { if (onTimeout) onTimeout(); return setTimeout(fn, ms); },
    querySelectorDeep: () => (anchor ? { element: anchor } : null),
    domQuerySelector: async () => {
      if (!anchor) throw new Error('ELEMENT_NOT_FOUND');
    }
  };
  vm.createContext(ctx);
  vm.runInContext(
    RESOLVE_SRC + '\n' + sliceDomLabelledby(readSrc('content-script.js')) + '\nthis.__domLabelledby = domLabelledby;',
    ctx
  );
  return ctx;
}

describe('seventy-third log follow-up: $labelledby hydration retry', () => {
  it('Case A: referenced span hydrates after 2 polls → returns the hydrated text', async () => {
    const html = '<span id="tip"></span><a id="a" class="a" aria-labelledby="tip">x</a>';
    const dom = new JSDOM(html, { url: 'https://example.com/page' });
    const anchor = dom.window.document.getElementById('a');
    const tip = dom.window.document.getElementById('tip');
    const ctx = makeCtx(dom, anchor);
    // Hydrate the referenced span lazily: flip its text after ~2 poll ticks.
    setTimeout(() => { tip.textContent = 'September 6'; }, 320);
    const r = await ctx.__domLabelledby('.a', null, 1500);
    assert.equal(r.result.text, 'September 6');
    assert.equal(r.result.refCount, 1);
    assert.equal(JSON.stringify(r.result.missingIds), '[]');
    assert.ok(!r.result.note, 'no falsification note on a hydrated read');
  });

  it('Case B: chain never hydrates → empty text + not-hydrated teaching note', async () => {
    const html = '<a id="a" class="a" aria-labelledby="tip">x</a>';
    const dom = new JSDOM(html, { url: 'https://example.com/page' });
    const anchor = dom.window.document.getElementById('a');
    const ctx = makeCtx(dom, anchor);
    const r = await ctx.__domLabelledby('.a', null, 400);
    assert.equal(r.result.text, '');
    assert.equal(JSON.stringify(r.result.missingIds), '["tip"]');
    assert.match(r.result.note, /not hydrated after retrying/);
    assert.match(r.result.note, /mount lazily/);
    assert.match(r.result.note, /hover the anchor/);
    // Envelope intact.
    assert.equal(r.result.attr, 'aria-labelledby');
    assert.ok(r._diagnostics && r._diagnostics.api === 'labelledby');
  });

  it('Case B2: refs resolve but carry no text → retried + taught, not silently green', async () => {
    const html = '<span id="tip"></span><a id="a" class="a" aria-labelledby="tip">x</a>';
    const dom = new JSDOM(html, { url: 'https://example.com/page' });
    const anchor = dom.window.document.getElementById('a');
    const ctx = makeCtx(dom, anchor);
    const r = await ctx.__domLabelledby('.a', null, 350);
    assert.equal(r.result.text, '');
    assert.equal(r.result.refCount, 1);
    assert.match(r.result.note, /not hydrated after retrying/);
  });

  it('Case C: no reference attribute at all → single-shot, absent-attr note, zero retries', async () => {
    const html = '<a id="a" class="a" href="/x">x</a>';
    const dom = new JSDOM(html, { url: 'https://example.com/page' });
    const anchor = dom.window.document.getElementById('a');
    let timeoutCalls = 0;
    const ctx = makeCtx(dom, anchor, () => { timeoutCalls += 1; });
    const r = await ctx.__domLabelledby('.a', null, 1500);
    assert.equal(r.result.text, '');
    assert.match(r.result.note, /is absent/);
    assert.doesNotMatch(r.result.note, /not hydrated after retrying/);
    assert.equal(timeoutCalls, 0, 'a structural absent-attr must not burn the retry loop');
  });

  it('Case D: element never appears → ELEMENT_NOT_FOUND unchanged', async () => {
    const html = '<div></div>';
    const dom = new JSDOM(html, { url: 'https://example.com/page' });
    const ctx = makeCtx(dom, null);
    await assert.rejects(() => ctx.__domLabelledby('.missing', null, 300), /ELEMENT_NOT_FOUND/);
  });

  it('source audit: one shared deadline, retry gate excludes the absent-attr shape', () => {
    const body = sliceDomLabelledby(readSrc('content-script.js'));
    assert.match(body, /const budget = \(typeof timeoutMs === 'number' && timeoutMs > 0\) \? timeoutMs : 5000/);
    assert.match(body, /const deadline = Date\.now\(\) \+ budget/);
    // Element-wait consumes from the SAME budget (no second deadline).
    assert.ok(body.indexOf('await domQuerySelector(sel, budget)') > -1);
    assert.match(body, /refCount > 0 && !resolved\.text/);
    assert.match(body, /missingIds && resolved\.missingIds\.length/);
  });

  it('DSL guide teaches the retry clause', () => {
    const src = readSrc('lib/wizard-utils.js');
    const idx = src.indexOf('- $labelledby(selector');
    const line = src.slice(idx, src.indexOf('\n', idx));
    assert.match(line, /RETRIES until non-empty within the same timeoutMs/);
    assert.match(line, /hydrate their reference chains lazily/);
  });
});

// Universality guard over the new strings.
describe('seventy-third log universality guard', () => {
  const FORBIDDEN = /facebook|twitter|linkedin|tiktok|reddit|\bfb\b/i;
  it('the retry code + note + guide clause carry no site tokens', () => {
    const body = sliceDomLabelledby(readSrc('content-script.js'));
    const retryWindow = body.slice(body.indexOf('Seventy-third log follow-up'), body.indexOf('Seventy-third log follow-up') + 2200);
    const guide = readSrc('lib/wizard-utils.js').slice(
      readSrc('lib/wizard-utils.js').indexOf('- $labelledby(selector'),
      readSrc('lib/wizard-utils.js').indexOf('- $labelledby(selector') + 2200);
    for (const s of [retryWindow, guide]) {
      assert.ok(!FORBIDDEN.test(s), 'site token in new code string: ' + String(s).slice(0, 120));
    }
  });
});
