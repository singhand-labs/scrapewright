// Regression for the console.log 2026-08-04 04:30:09 FB search extraction incident.
//
// SYMPTOM: wizard testScript reported SUCCESS with 10 posts, but ALL 10 records
// were identical:
//   {"group":"AI人工智能 & 機器人","username":"","content":"【智慧交通基金...","likes":"3","comments":"12","shares":"11"}
//   (× 10, character-for-character identical)
//
// ROOT CAUSE: the LLM-generated step 4 wrote a `for (article of articles)` loop
// but used GLOBAL sub-queries inside the loop body:
//
//   const articles = await $list('div[role="article"]');
//   for (const article of articles) {
//     const groupEls = await $list('div[role="article"] h3 a[href*="/groups/"] span');  // ← GLOBAL
//     if (groupEls.length > 0) group = groupEls[0].textContent;  // ← always same first match
//     // ... same global pattern for username, content, likes, comments, shares
//     posts.push({ group, username, content, ... });
//   }
//
// Every iteration writes the SAME first-match values into the current record.
// The filter `if (!content && !username && !group) continue;` lets every
// iteration through (they all have content set), so 10 articles → 10 IDENTICAL
// records.
//
// WHY THE FRAMEWORK MISSED IT:
//   - findEmptyExtractionFields → []  (fields aren't empty, they're duplicated)
//   - detectEmptyOutputFieldsByRatio → []  (no field is empty in >50% of records)
//   - validateOutputAgainstSchema → ok  (array length > 0, required keys present)
//   → testScript reported SUCCESS. The user only discovered the bug by manual
//     inspection of the result pane.
//
// AutoFix only fired later on an UNRELATED error ("Failed to create tab 10s
// timeout"), and the LLM happened to rewrite step 4 to use $extractListMulti
// with per-record sub-selectors as a side effect of fixing the unrelated
// error. Without that lucky break, 10 identical records would have shipped.
//
// FIX: detectDuplicateRecords — when N≥3 records in an array-of-objects
// output ALL share the same signature (stable JSON of declared sub-field
// values), the extraction is broken. Throw DUPLICATE_RECORDS so autoFix
// fires with the strong "fix failing step" prompt.
//
// UNIVERSALITY: this is NOT FB-specific. Any list extraction where the LLM
// writes a per-record loop with unscoped sub-queries produces duplicates.
// The detector and the SCRIPT_DSL_GUIDE rule (audited below) must be
// site-agnostic.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  detectDuplicateRecords,
  formatDuplicateRecordsSignal
} = require('../lib/wizard-utils');

// Schema shaped like the FB incident: posts[] is an array of objects with
// several declared sub-fields.
const SCHEMA = {
  type: 'object',
  properties: {
    posts: {
      type: 'array',
      items: {
        type: 'object',
        required: ['group', 'username', 'content', 'likes', 'comments', 'shares'],
        properties: {
          group: { type: 'string' },
          username: { type: 'string' },
          content: { type: 'string' },
          likes: { type: 'string' },
          comments: { type: 'string' },
          shares: { type: 'string' }
        }
      }
    }
  },
  required: ['posts']
};

// Reproduces the exact incident: 10 IDENTICAL records. The detector must flag.
const TEN_IDENTICAL = {
  posts: Array.from({ length: 10 }, () => ({
    group: 'AI人工智能 & 機器人',
    username: '',
    content: '【智慧交通基金  ︳以創新科技推動智慧出行】 科… 展开',
    likes: '3',
    comments: '12',
    shares: '11'
  }))
};

// Sanity: 3 distinct records must NOT be flagged.
const THREE_DISTINCT = {
  posts: [
    { group: '', username: 'Alice', content: 'aaa', likes: '1', comments: '0', shares: '0' },
    { group: '', username: 'Bob',   content: 'bbb', likes: '2', comments: '1', shares: '0' },
    { group: '', username: 'Carol', content: 'ccc', likes: '3', comments: '0', shares: '1' }
  ]
};

// Mixed: 5 identical + 1 different. The detector with default 100% threshold
// should NOT flag (the unique record breaks the all-same pattern). Caller
// can lower threshold if it wants partial-duplicate detection.
const FIVE_IDENTICAL_ONE_DIFFERENT = {
  posts: [
    { group: 'X', username: 'U', content: 'C', likes: '1', comments: '0', shares: '0' },
    { group: 'X', username: 'U', content: 'C', likes: '1', comments: '0', shares: '0' },
    { group: 'X', username: 'U', content: 'C', likes: '1', comments: '0', shares: '0' },
    { group: 'X', username: 'U', content: 'C', likes: '1', comments: '0', shares: '0' },
    { group: 'X', username: 'U', content: 'C', likes: '1', comments: '0', shares: '0' },
    { group: 'Y', username: 'V', content: 'D', likes: '9', comments: '9', shares: '9' }
  ]
};

describe('detectDuplicateRecords — flags the all-identical-records antipattern', () => {
  it('flags when N≥3 records in an array-of-objects output ALL share the same signature', () => {
    const out = detectDuplicateRecords(TEN_IDENTICAL, SCHEMA);
    assert.ok(Array.isArray(out) && out.length === 1,
      'expected exactly 1 flagged field (posts), got: ' + JSON.stringify(out));
    const f = out[0];
    assert.equal(f.field, 'posts');
    assert.equal(f.totalRecords, 10);
    assert.equal(f.uniqueSignatures, 1);
    assert.equal(f.duplicateRatio, 1);
    assert.ok(typeof f.sampleDuplicate === 'string' && f.sampleDuplicate.length > 0,
      'sampleDuplicate must be a non-empty string for display');
  });

  it('does NOT flag when records are genuinely distinct', () => {
    const out = detectDuplicateRecords(THREE_DISTINCT, SCHEMA);
    assert.deepEqual(out, []);
  });

  it('does NOT flag when at least one record breaks the all-same pattern (default 100% threshold)', () => {
    // 5 identical + 1 different — default threshold requires 100% identical,
    // so this should NOT fire. The framework should not aggressively block
    // deploy when the script clearly produced *some* real diversity.
    const out = detectDuplicateRecords(FIVE_IDENTICAL_ONE_DIFFERENT, SCHEMA);
    assert.deepEqual(out, []);
  });

  it('respects options.duplicateRatioThreshold for partial-duplicate detection', () => {
    // Same input as above, but caller wants to flag when ≥80% are identical.
    // 5 of 6 = 83% — should now fire.
    const out = detectDuplicateRecords(FIVE_IDENTICAL_ONE_DIFFERENT, SCHEMA, {
      duplicateRatioThreshold: 0.8
    });
    assert.ok(out.length === 1, 'expected flag at 80% threshold; got: ' + JSON.stringify(out));
    assert.equal(out[0].totalRecords, 6);
    assert.ok(out[0].duplicateRatio >= 0.8);
  });

  it('does NOT flag arrays shorter than options.minRecords (default 3)', () => {
    const twoIdentical = {
      posts: [
        { group: 'X', username: 'U', content: 'C', likes: '1', comments: '0', shares: '0' },
        { group: 'X', username: 'U', content: 'C', likes: '1', comments: '0', shares: '0' }
      ]
    };
    const out = detectDuplicateRecords(twoIdentical, SCHEMA);
    assert.deepEqual(out, []);
  });

  it('is robust to non-array / missing schema / scalar-array fields (returns [])', () => {
    assert.deepEqual(detectDuplicateRecords(null, SCHEMA), []);
    assert.deepEqual(detectDuplicateRecords({}, SCHEMA), []);
    assert.deepEqual(detectDuplicateRecords({ posts: 'not an array' }, SCHEMA), []);
    // Scalar-array field (string[]) — not array-of-objects, must be skipped
    const scalarSchema = {
      type: 'object',
      properties: { tags: { type: 'array', items: { type: 'string' } } },
      required: ['tags']
    };
    assert.deepEqual(
      detectDuplicateRecords({ tags: ['a', 'a', 'a'] }, scalarSchema),
      []
    );
  });
});

describe('formatDuplicateRecordsSignal — renders a prompt-ready block', () => {
  it('returns empty string when there is nothing to surface', () => {
    assert.equal(formatDuplicateRecordsSignal([]), '');
    assert.equal(formatDuplicateRecordsSignal(null), '');
    assert.equal(formatDuplicateRecordsSignal(undefined), '');
  });

  it('produces a DUPLICATE RECORDS block naming the field and counts', () => {
    const out = detectDuplicateRecords(TEN_IDENTICAL, SCHEMA);
    const text = formatDuplicateRecordsSignal(out);
    assert.match(text, /DUPLICATE RECORDS/i);
    assert.match(text, /posts/);
    assert.match(text, /10/);  // totalRecords
    assert.match(text, /global\s+sub-.*loop|sub-selector.*loop|per-record/i);
  });
});

// Source-text audit: SCRIPT_DSL_GUIDE must teach the LLM to scope per-record
// sub-selectors (use $extractListMulti or scope querySelector), AND must show
// the WRONG pattern that caused the FB incident. This prevents regression
// if a future edit strips the rule.
describe('SCRIPT_DSL_GUIDE — Rule for per-record sub-selector scoping', () => {
  const UTILS_PATH = path.join(__dirname, '..', 'lib', 'wizard-utils.js');

  function loadScriptDslGuide() {
    const src = fs.readFileSync(UTILS_PATH, 'utf8');
    const startIdx = src.indexOf('SCRIPT_DSL_GUIDE');
    assert.ok(startIdx > -1, 'wizard-utils.js: SCRIPT_DSL_GUIDE not found');
    const eqIdx = src.indexOf('=', startIdx);
    const btIdx = src.indexOf('`', eqIdx);
    assert.ok(btIdx > -1, 'wizard-utils.js: SCRIPT_DSL_GUIDE opening backtick not found');
    const endMarker = '`;';
    const endIdx = src.indexOf(endMarker, btIdx + 1);
    assert.ok(endIdx > btIdx, 'wizard-utils.js: SCRIPT_DSL_GUIDE closing backtick-semicolon not found');
    return src.slice(btIdx + 1, endIdx);
  }

  it('teaches that per-record sub-selectors MUST be scoped to the current record', () => {
    const guide = loadScriptDslGuide();
    // Look for a rule heading mentioning per-record scoping OR sub-selector
    // scoping. Accept several phrasings so a future wording edit doesn't
    // silently break the audit.
    assert.match(
      guide,
      /PER-RECORD\s+SUB-SELECTOR|SUB-SELECTOR\s+SCOPING|SCOPE\s+SUB-SELECTORS/i,
      'SCRIPT_DSL_GUIDE must have a rule about scoping per-record sub-selectors'
    );
  });

  it('shows the WRONG pattern: a for-loop with a global sub-selector inside', () => {
    const guide = loadScriptDslGuide();
    // The exact anti-pattern from the FB log:
    //   for (const article of articles) {
    //     const x = await $list('div[role="article"] ...');  // ← GLOBAL
    // We need the guide to show this concretely so the LLM recognizes the
    // shape. Match on a for-loop containing an unscoped $list call.
    assert.match(
      guide,
      /for\s*\(\s*const\s+\w+\s+of\s+\w+\s*\)[^]*\$list\s*\(\s*['"][^'"]*['"]\s*\)/,
      'guide must show the WRONG for-loop-with-global-$list antipattern'
    );
  });

  it('references the framework\'s DUPLICATE_RECORDS detector so the LLM understands the consequence', () => {
    const guide = loadScriptDslGuide();
    assert.match(
      guide,
      /DUPLICATE_RECORDS|duplicate\s+records/i,
      'guide must reference the DUPLICATE_RECORDS detector/output signal'
    );
  });

  it('shows the RIGHT pattern ($extractListMulti or scoped querySelector)', () => {
    const guide = loadScriptDslGuide();
    // The RIGHT pattern uses $extractListMulti with sub-selectors relative to
    // the container, OR element.querySelector inside the loop.
    assert.ok(
      /\$extractListMulti/.test(guide) && /querySelector/.test(guide),
      'guide must show $extractListMulti and element.querySelector as the RIGHT scoping mechanisms'
    );
  });
});
