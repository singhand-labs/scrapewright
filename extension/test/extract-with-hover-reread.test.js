// Forty-fourth log (2026-09-08): $extractWithHover extracted ALL field values
// BEFORE the hover batch, but on a cold verify tab the hover batch is exactly
// what hydrates lazily-mounted ARIA label chains. Live evidence: postingTime
// (fieldMap labelledby on the timestamp anchor) shipped "" in 4/4 records on
// every verify, while the SAME resolution — recomputed by the diagnostics
// census AFTER the hover loop — resolved text (emptyFieldDiagnostics flipped
// populated→null across byte-identical scripts; the census saw the
// post-hover DOM, the records never did). Warm research tab resolved fine,
// so the model misdiagnosed it as unverifiable "fresh-tab state".
//
// Fix under test: after the hover loop, re-read labelledby-spec fields whose
// value came back empty/undefined; fill from the post-hover DOM. Non-empty
// values are never overwritten; non-labelledby fields are never re-read.
const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const LIB = require('../lib/list-extract-ops');
const extractWithHoverRecords = LIB.extractWithHoverRecords;

// ---- inline-mirror harness (same technique as labelledby-fieldmap.test.js) ----
function extractFnSource(source, name) {
  const start = source.indexOf('function ' + name + '(');
  assert.ok(start !== -1, 'could not find function ' + name);
  let depth = 0, inString = null, bodyStart = -1, bodyEnd = -1;
  for (let i = start; i < source.length; i++) {
    const ch = source[i];
    const next = source[i + 1];
    if (inString) {
      if (ch === '\\') { i++; continue; }
      if (ch === inString) inString = null;
      continue;
    }
    if (ch === '/' && next === '/') { while (i < source.length && source[i] !== '\n') i++; continue; }
    if (ch === '/' && next === '*') { i += 2; while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i++; i++; continue; }
    if (ch === '"' || ch === "'" || ch === '`') { inString = ch; continue; }
    if (ch === '{') { if (depth === 0) bodyStart = i + 1; depth++; }
    else if (ch === '}') { depth--; if (depth === 0) { bodyEnd = i; break; } }
  }
  assert.ok(bodyEnd !== -1, 'function ' + name + ' body never closes');
  return source.slice(start, bodyEnd + 1);
}

function buildInlineOps(dom) {
  const csSrc = fs.readFileSync(path.join(__dirname, '..', 'content-script.js'), 'utf8');
  global.document = dom.window.document;
  const resolverSrc = extractFnSource(csSrc, 'resolveLabelledbyText');
  const factorySrc = extractFnSource(csSrc, 'createInlineListExtractOps');
  (0, eval)(resolverSrc);
  const factory = (0, eval)(factorySrc + '; createInlineListExtractOps');
  return factory();
}

function setupDOM(html) {
  const dom = new JSDOM(html, { url: 'https://example.com/search' });
  global.document = dom.window.document;
  global.window = dom.window;
  return dom;
}

describe('forty-fourth log: post-hover re-read of empty labelledby fields', () => {
  it('fills a labelledby field that only resolves after the hover hydrated the reference', async () => {
    // Cold-tab shape: the timestamp anchor exists but carries no reference
    // attribute yet; the hover (mocked) mounts the carrier span + hidden
    // referenced text — the page's lazy hydration.
    const dom = setupDOM(
      '<div class="card" id="c1">' +
        '<a class="ts" href="?__cft__=x">a day ago</a>' +
      '</div>' +
      '<span id="tip" hidden>July 17, 2026 at 3:42 PM</span>'
    );
    const containers = [dom.window.document.getElementById('c1')];
    let hovers = 0;
    const records = await extractWithHoverRecords(
      containers,
      { postingTime: { selector: '.ts', labelledby: true } },
      { anchorSel: '.ts' },
      async () => {
        hovers++;
        const a = dom.window.document.querySelector('.ts');
        const carrier = dom.window.document.createElement('span');
        carrier.setAttribute('aria-labelledby', 'tip');
        a.appendChild(carrier);
        return { hovered: true, htmlSnippet: '<div></div>' };
      }
    );
    assert.ok(hovers > 0, 'hover batch ran');
    assert.equal(records[0].postingTime, 'July 17, 2026 at 3:42 PM',
      'the value the pre-hover read could not see must be filled from the post-hover DOM');
  });

  it('own-attribute hydration shape also fills (attr appears on the matched element itself)', async () => {
    const dom = setupDOM(
      '<div class="card" id="c1"><a class="ts" href="?__cft__=x">2 hrs</a></div>' +
      '<span id="tip" hidden>September 8, 2026 at 11:04 AM</span>'
    );
    const containers = [dom.window.document.getElementById('c1')];
    const records = await extractWithHoverRecords(
      containers,
      { postingTime: { selector: '.ts', labelledby: true } },
      { anchorSel: '.ts' },
      async () => {
        dom.window.document.querySelector('.ts').setAttribute('aria-labelledby', 'tip');
        return { hovered: true, htmlSnippet: '<div></div>' };
      }
    );
    assert.equal(records[0].postingTime, 'September 8, 2026 at 11:04 AM');
  });

  it('never overwrites a value the pre-hover read already resolved', async () => {
    const dom = setupDOM(
      '<div class="card" id="c1">' +
        '<a class="ts" aria-labelledby="t1">1 hr</a>' +
        '<span id="t1" hidden>September 8, 2026 at 10:00 AM</span>' +
      '</div>'
    );
    const containers = [dom.window.document.getElementById('c1')];
    const records = await extractWithHoverRecords(
      containers,
      { postingTime: { selector: '.ts', labelledby: true } },
      { anchorSel: '.ts' },
      async () => {
        // A hostile late mount pointing somewhere else must not win.
        dom.window.document.querySelector('.ts').setAttribute('aria-labelledby', 't1 t1');
        return { hovered: true, htmlSnippet: null };
      }
    );
    assert.equal(records[0].postingTime, 'September 8, 2026 at 10:00 AM',
      'pre-hover resolved value stands — the re-read only fills EMPTY fields');
  });

  it('non-labelledby fields are never re-read (attr/text reads do not hydrate from hovers)', async () => {
    const dom = setupDOM('<div class="card" id="c1"><a class="lnk" href="/x">x</a></div>');
    const containers = [dom.window.document.getElementById('c1')];
    const records = await extractWithHoverRecords(
      containers,
      { postUrl: { selector: '.lnk', attr: 'href' } },
      { anchorSel: '.lnk' },
      async () => {
        dom.window.document.querySelector('.lnk').setAttribute('href', '/hydrated');
        return { hovered: true, htmlSnippet: '<div></div>' };
      }
    );
    assert.equal(records[0].postUrl, '/x',
      'attr reads keep their pre-hover value — the re-read is labelledby-only');
  });

  it('an anchor whose hover hydrates nothing stays honestly empty', async () => {
    const dom = setupDOM('<div class="card" id="c1"><a class="ts" href="?__cft__=x">yesterday</a></div>');
    const containers = [dom.window.document.getElementById('c1')];
    const records = await extractWithHoverRecords(
      containers,
      { postingTime: { selector: '.ts', labelledby: true } },
      { anchorSel: '.ts' },
      async () => ({ hovered: true, htmlSnippet: '<div></div>' })
    );
    assert.equal(records[0].postingTime, '');
  });
});

describe('forty-fourth log: inline mirror carries the same post-hover re-read (drift guard)', () => {
  it('fills a labelledby field that only resolves after the hover hydrated the reference', async () => {
    const dom = setupDOM(
      '<div class="card" id="c1"><a class="ts" href="?__cft__=x">a day ago</a></div>' +
      '<span id="tip" hidden>July 17, 2026 at 3:42 PM</span>'
    );
    const ops = buildInlineOps(dom);
    const containers = [dom.window.document.getElementById('c1')];
    const records = await ops.extractWithHoverRecords(
      containers,
      { postingTime: { selector: '.ts', labelledby: true } },
      { anchorSel: '.ts' },
      async () => {
        const a = dom.window.document.querySelector('.ts');
        const carrier = dom.window.document.createElement('span');
        carrier.setAttribute('aria-labelledby', 'tip');
        a.appendChild(carrier);
        return { hovered: true, htmlSnippet: '<div></div>' };
      }
    );
    assert.equal(records[0].postingTime, 'July 17, 2026 at 3:42 PM');
  });
});
