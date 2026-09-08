// extension/test/feedback-closure-note.test.js
//
// Fortieth log: the user submitted explicit feedback ("hoverCards empty,
// engagement counts missed, timestamp full value via hover tooltip"); the
// resumed session re-verified, went green, and finished — with EVERY
// reported problem still unfixed (hoverCards structurally empty via an
// invented popoverHtml field, comments shipping the "Leave a comment"
// button label, duplicates from nested container matches). The resume
// teaching said "diagnose, fix, verify.run again before finishing" but
// never required the finish to CLOSE each named problem. A green
// verify.run alone must not close user feedback: shape-only checks pass
// empty hover fields, UI-label junk, and duplicate records.
//
// This pins the USER FEEDBACK continuation note in wizard.js to require
// per-problem closure with evidence, and honest disclosure for problems
// that could not be fixed.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const WIZARD_SRC = fs.readFileSync(path.join(__dirname, '..', 'wizard.js'), 'utf8');

function feedbackNoteText() {
  const i = WIZARD_SRC.indexOf('USER FEEDBACK (fix request)');
  assert.ok(i !== -1, 'wizard.js: USER FEEDBACK (fix request) continuation note not found');
  const end = WIZARD_SRC.indexOf(';', i);
  assert.ok(end > i, 'wizard.js: feedback note statement not terminated');
  return WIZARD_SRC.slice(i, end);
}

describe('USER FEEDBACK continuation note — per-problem closure (fortieth log)', () => {
  it('keeps the operational resume instructions (page.open first, diagnose, fix, verify)', () => {
    const note = feedbackNoteText();
    assert.match(note, /page\.open/);
    assert.match(note, /service\.update/);
    assert.match(note, /verify\.run/);
  });

  it('requires the finish to close EACH named problem with field-value evidence', () => {
    const note = feedbackNoteText();
    assert.match(note, /EACH named problem|per reported problem|each reported problem/i);
    assert.match(note, /field values from the verify output|verify output/i);
  });

  it('teaches that a green verify.run alone does not close user feedback', () => {
    const note = feedbackNoteText();
    assert.match(note, /green verify\.run alone does not close user feedback/i);
    assert.match(note, /duplicate records|junk|empty/i);
  });

  it('requires honest disclosure for problems that could not be fixed', () => {
    const note = feedbackNoteText();
    assert.match(note, /could not fix|cannot fix|unfixed/i);
    assert.match(note, /disclos/i);
  });
});
