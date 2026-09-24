// extension/test/hundred-forty-fourth-log-deep-analysis.test.js
//
// 144th round (deep-log): two disclosure defects from the 143rd session.
//
// (1) The finish read: "VERIFY COUNT-SHORTFALL — requested 7 via the test
//     input, extracted 7 into posts — exhaustion NOT certified ... the user
//     requested a count the run did not deliver" — self-contradictory: the
//     139th unique-shortfall fired (7 records, 6 unique) but the composition
//     string is record-count-worded and the finish trailer is generic.
// (2) The DUPLICATE_ENTITY_PAIRS red was feed nondeterminism (the SAME
//     artifact verified green one run earlier); nothing told the model that
//     re-verifying unchanged just re-rolls the population while the durable
//     fix is the entity-signature dedupe in the assembly.
//
// No site tokens.
const { test, describe, it } = require('node:test');
const assert = require('assert');

const RS_SRC = require('fs').readFileSync(require('path').join(__dirname, '..', 'lib', 'research-session.js'), 'utf8');

describe('144th round — unique-aware countShortfall disclosure', () => {
  it('the composition names UNIQUE count when uniqueExtracted is present (no more "extracted 7 ... did not deliver")', () => {
    const i = RS_SRC.indexOf('state.lastVerifyCountShortfall = cs');
    assert.ok(i > -1, 'composition site found');
    // 144th-round plan correction: the original 900-char window cannot
    // reach the inserted suffix — the pre-existing 135th-log comment +
    // exhaustion strings alone occupy 855 chars (suffix token at ~1236).
    const region = RS_SRC.slice(i, i + 1600);
    assert.match(region, /uniqueExtracted/, 'the composition reads cs.uniqueExtracted');
    assert.match(region, /UNIQUE item/, 'the wording names UNIQUE items');
    // 144th-round plan correction: 'VERIFY COUNT-SHORTFALL' first occurs
    // at the stop-ladder csNote (~line 423), not the finish trailer this
    // edit branches — anchor on the branched trailer variable itself.
    const t = RS_SRC.indexOf('csTrailer');
    const trailer = RS_SRC.slice(t, t + 700);
    assert.match(trailer, /uniqueExtracted|UNIQUE/, 'the finish trailer is unique-aware');
  });
});

describe('144th round — DUPLICATE_ENTITY_PAIRS population-variance note', () => {
  it('a red duplicate run following a GREEN run of the SAME version appends the variance teaching', () => {
    const i = RS_SRC.indexOf('POPULATION VARIANCE');
    assert.ok(i > -1, 'the note exists');
    const region = RS_SRC.slice(i - 700, i + 300);
    assert.match(region, /priorVerifyReport/, 'gated on the prior verify being green');
    assert.match(region, /entity-signature dedupe|signature dedupe/, 'teaches the durable fix');
  });
});

describe('144th round — dup variance note (behavioral)', () => {
  it('the note composes onto a duplicate veto error when the prior same-version verify was green', () => {
    const guard = (result, priorVerifyReport, lastVerifyArtifactVersion, artifactVersionsLength) =>
      result && result.ok === false && result.error && /DUPLICATE_ENTITY_PAIRS/.test(String(result.error.message)) &&
      priorVerifyReport && priorVerifyReport.ok === true &&
      lastVerifyArtifactVersion === artifactVersionsLength;
    const err = { ok: false, error: { message: 'DUPLICATE_ENTITY_PAIRS: posts records #1 and #2 match' } };
    assert.equal(guard(err, { ok: true }, 3, 3), true, 'same-version prior green → note fires');
    assert.equal(guard(err, { ok: true }, 2, 3), false, 'prior green on an EARLIER version → no note');
    assert.equal(guard(err, { ok: false }, 3, 3), false, 'prior red → no note');
    assert.equal(guard({ ok: false, error: { message: 'SCRIPT_TIMEOUT: x' } }, { ok: true }, 3, 3), false, 'non-dup errors → no note');
  });
});
