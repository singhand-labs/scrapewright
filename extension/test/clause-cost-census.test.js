// Forty-fourth log FIX-C: the zero-match paths already attach a selector
// differential, but a PARTIAL population loss was invisible. The verify
// container carried an ad-marker exclusion clause (`:has([data-ad-rendering
// -role])`) that fired the adMarkerSelectors detector every round while the
// clause-cost evidence never reached the census — the model kept the clause
// for 7 rounds without ever seeing that it (or a future polarity-inverted
// exclusion) was removing cards from the kept set. Universal clause-cost
// census: whenever the container selector carries trailing :not()/:has()
// clauses AND containers matched > 0, the census carries the clause-by-clause
// counts. Infrastructure-level, no site tokens.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'content-script.js'), 'utf8');

function sliceFn(name) {
  const start = SRC.indexOf('function ' + name + '(');
  assert.ok(start > -1, 'function ' + name + ' exists in content-script.js');
  let i = SRC.indexOf('{', start);
  let depth = 0;
  for (; i < SRC.length; i++) {
    if (SRC[i] === '{') depth += 1;
    else if (SRC[i] === '}') { depth -= 1; if (depth === 0) return SRC.slice(start, i + 1); }
  }
  throw new Error('unbalanced braces for ' + name);
}

function buildHelper(fakeDiff) {
  const factory = eval('(function (computeSelectorDifferential) { return (' + sliceFn('attachClauseCostCensus') + '); })');
  return factory(() => fakeDiff);
}

describe('FIX-C: attachClauseCostCensus (clause-cost census on populated containers)', () => {
  it('a clause-bearing selector with a partial loss attaches the differential + a clause-cost note', () => {
    const fn = buildHelper([
      { sel: 'div[role=feed] div[aria-posinset]', count: 6 },
      { sel: 'div[role=feed] div[aria-posinset]:has([data-x])', count: 4 }
    ]);
    const diagnostics = { api: 'extractList', containerMatches: 4, perField: [] };
    const out = fn(diagnostics, 'div[role=feed] div[aria-posinset]:has([data-x])');
    assert.equal(out, diagnostics, 'mutates the census in place and returns it');
    assert.deepEqual(out.selectorDifferential, [
      { sel: 'div[role=feed] div[aria-posinset]', count: 6 },
      { sel: 'div[role=feed] div[aria-posinset]:has([data-x])', count: 4 }
    ]);
    assert.match(out.note || '', /clause cost/);
    assert.match(out.note || '', /removed 2 of 6/, 'the note quantifies the loss against the base population');
  });

  it('clause-bearing but zero loss: differential attached, no note noise', () => {
    const fn = buildHelper([
      { sel: 'div.card', count: 4 },
      { sel: 'div.card:not(.hidden)', count: 4 }
    ]);
    const diagnostics = { api: 'extractList', containerMatches: 4, perField: [] };
    const out = fn(diagnostics, 'div.card:not(.hidden)');
    assert.deepEqual(out.selectorDifferential, [
      { sel: 'div.card', count: 4 },
      { sel: 'div.card:not(.hidden)', count: 4 }
    ]);
    assert.equal(out.note, undefined);
  });

  it('clause-free selector: census untouched (no selectorDifferential key)', () => {
    const fn = buildHelper(null);
    const diagnostics = { api: 'extractList', containerMatches: 4, perField: [] };
    const out = fn(diagnostics, 'div[role=feed] > div');
    assert.equal('selectorDifferential' in out, false);
    assert.equal('note' in out, false);
  });

  it('null census is tolerated (fallback shape path)', () => {
    const fn = buildHelper([{ sel: 'a', count: 1 }, { sel: 'a:not(.x)', count: 0 }]);
    assert.equal(fn(null, 'a:not(.x)'), null);
  });
});

describe('FIX-C: all three populated-path wrappers run the census (source audit)', () => {
  for (const name of ['domExtractList', 'domExtractListMulti', 'domExtractWithHover']) {
    it(name + ' attaches the clause-cost census on its success path', () => {
      const body = sliceFn(name);
      assert.ok(body.includes('attachClauseCostCensus('),
        name + ' must call attachClauseCostCensus after computing its census');
      const censusIdx = body.indexOf('computeExtractListDiagnostics(');
      const attachIdx = body.indexOf('attachClauseCostCensus(');
      assert.ok(censusIdx > -1, name + ' computes the extract census');
      assert.ok(attachIdx > censusIdx, 'the census attach runs AFTER the census is computed');
    });
  }
});

describe('FIX-C: end-to-end — domExtractList success path carries the differential', () => {
  it('populated clause-bearing container: _diagnostics.selectorDifferential survives the wrapper', async () => {
    const containers = [{}, {}];
    const censusFactory = eval('(function (computeSelectorDifferential) { return (' + sliceFn('attachClauseCostCensus') + '); })');
    const attachClauseCostCensus = censusFactory(() => [{ sel: '.post', count: 3 }, { sel: '.post:has(.ad)', count: 2 }]);
    const factory = eval('(function (querySelectorAllDeep, sendDebugLog, notifyBackgroundDiagnostic, getListExtractOps, computeSelectorDifferential, formatSelectorDifferentialNote, attachClauseCostCensus) { return (' + sliceFn('domExtractList') + '); })');
    const fn = factory(
      () => containers,
      () => {},
      () => {},
      () => ({
        extractListRecords: () => [{ title: 'a' }, { title: 'b' }],
        computeExtractListDiagnostics: (cs) => ({ api: 'extractList', containerSelector: '.post:has(.ad)', containerMatches: cs.length, perField: [] })
      }),
      () => null,
      () => null,
      attachClauseCostCensus
    );
    const out = fn('.post:has(.ad)', { title: { selector: '.t' } }, {});
    assert.equal(out.result.length, 2);
    assert.deepEqual(out._diagnostics.selectorDifferential, [
      { sel: '.post', count: 3 },
      { sel: '.post:has(.ad)', count: 2 }
    ]);
    assert.match(out._diagnostics.note || '', /removed 1 of 3/);
  });
});
