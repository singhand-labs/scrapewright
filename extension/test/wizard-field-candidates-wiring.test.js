const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

// discovery module needs DOMParser/NodeFilter/Node at require-time. Mirror
// field-candidate-discovery.test.js's JSDOM bootstrap.
const { JSDOM } = require('jsdom');
const _dom = new JSDOM('<!DOCTYPE html><html><body></body></html>');
global.DOMParser = _dom.window.DOMParser;
global.NodeFilter = _dom.window.NodeFilter;
global.Node = _dom.window.Node;

// Load field-candidate-discovery from source so the test runs in Node
// without wizard.html. Mirrors field-candidate-discovery.test.js setup.
const { discoverFieldCandidates, formatFieldCandidatesBlock } = require(path.join(__dirname, '..', 'lib', 'field-candidate-discovery.js'));

// Test the wiring pipeline end-to-end with synthetic chronic-empty state.
// This verifies the same composition wizard.js performs inline: discovery
// on normalized record HTML + formatFieldCandidatesBlock rendering.

test('wiring pipeline: chronic-empty fields + record HTML -> non-empty FIELD CANDIDATES block', () => {
  const chronicEmptyFields = ['postTime', 'profileUrl'];
  const recordHtml = '<div><time>2h</time><a href="/u/1">Jane</a></div>';
  const result = discoverFieldCandidates(recordHtml, chronicEmptyFields);
  const block = formatFieldCandidatesBlock(result);
  assert.ok(block.startsWith('FIELD CANDIDATES'), 'block should start with FIELD CANDIDATES');
  assert.ok(block.includes('postTime'), 'should name postTime');
  assert.ok(block.includes('profileUrl'), 'should name profileUrl');
  assert.ok(block.includes('time-like'), 'should tag postTime as time-like');
  assert.ok(block.includes('url-like'), 'should tag profileUrl as url-like');
});

test('wiring pipeline: empty record HTML -> empty block (discovery skips)', () => {
  const result = discoverFieldCandidates('', ['postTime']);
  const block = formatFieldCandidatesBlock(result);
  assert.strictEqual(block, '');
});

test('wiring pipeline: no chronic-empty fields -> empty block', () => {
  const result = discoverFieldCandidates('<div><time>2h</time></div>', []);
  const block = formatFieldCandidatesBlock(result);
  assert.strictEqual(block, '');
});

test('wiring pipeline: iteration-2 suppression is enforced by attemptNum gate at call site (not by discovery)', () => {
  // The discovery function itself has no notion of attemptNum — it always
  // returns candidates when given fields + HTML. The attemptNum===1 gate
  // lives in wizard.js's runFixIteration. This test pins the contract:
  // discovery is stateless w.r.t. iterations; the caller is responsible
  // for the first-round-only suppression.
  const html = '<div><time>2h</time></div>';
  const r1 = discoverFieldCandidates(html, ['postTime']);
  const r2 = discoverFieldCandidates(html, ['postTime']);
  assert.deepStrictEqual(r1, r2, 'discovery is deterministic / stateless');
});

test('wizard.js wiring sanity: grep for fieldCandidatesSignal references', () => {
  // Source-text audit: confirm wizard.js actually interpolates the signal
  // (regression guard against silent-disable like RC30 part-2).
  const fs = require('fs');
  const wiz = fs.readFileSync(path.join(__dirname, '..', 'wizard.js'), 'utf8');
  assert.ok(/let fieldCandidatesSignal = ''/.test(wiz), 'should declare fieldCandidatesSignal');
  assert.ok(/attemptNum === 1/.test(wiz), 'should gate on attemptNum === 1');
  // Must be interpolated in BOTH branches (count >= 2).
  const matches = wiz.match(/fieldCandidatesSignal \? '\\n' \+ fieldCandidatesSignal/g) || [];
  assert.ok(matches.length >= 2, 'should interpolate fieldCandidatesSignal in both branches, got ' + matches.length);
  // Regression: the OLD broken lookup used `representative2._html` /
  // `representative2.outerHTML` and `finalData2.records`. Those lookups
  // silently returned undefined because output records are flat LLM-extracted
  // values, not DOM nodes. Verify the fix is in place — the wiring now reads
  // record HTML from executionEvents via getFirstRecordHtmlFromExecution.
  assert.ok(/getFirstRecordHtmlFromExecution\(/.test(wiz),
    'wizard.js should resolve record HTML via getFirstRecordHtmlFromExecution');
  assert.ok(!/representative2\._html|representative2\.outerHTML|finalData2\.records/.test(wiz),
    'wizard.js must not look up record HTML from output records (broken pattern)');
});

test('end-to-end: realistic wizardState shape -> discovery produces non-empty block', () => {
  // Regression for 2026-08-07 console.log bug: production FB scrape had
  // finalResult = { posts: [...] } (NOT an array, NO `records` key, records
  // are flat LLM-extracted objects with no _html/outerHTML). The first
  // wiring iteration silently emitted empty fieldCandidatesSignal even
  // though all gate conditions were met. This test pins the realistic
  // shape end-to-end: chronicEmpty detection + record HTML lookup from
  // executionEvents + discovery + formatting.
  const { detectEmptyOutputFieldsByRatio, findUpstreamExtractionStepId, getFirstRecordHtmlFromExecution } = require(path.join(__dirname, '..', 'lib', 'wizard-utils.js'));

  const wizardState = {
    outputSchema: {
      type: 'object',
      properties: {
        posts: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              postTime: { type: 'string' },
              profileUrl: { type: 'string' },
              content: { type: 'string' },
            },
          },
        },
      },
    },
    steps: [
      { id: '1', name: 'wait', script: 'await $count("div")' },
      { id: '2', name: 'scroll', script: 'await $scrollToBottom()' },
      { id: '3', name: 'expand', script: 'await $click("div")' },
      { id: '4', name: 'extract_posts',
        script: 'const r = await $extractListMulti("div[role=article]", { postTime: "time", profileUrl: "a[href]", content: "span" }); return { posts: r };' },
    ],
    annotations: [],
    testResult: {
      // KEY: data is wrapped in `posts`, not `records`. Old wiring looked for
      // `.records` and silently failed.
      finalResult: {
        posts: [
          { postTime: '', profileUrl: '', content: 'first post' },
          { postTime: '', profileUrl: '', content: 'second post' },
          { postTime: '', profileUrl: '', content: 'third post' },
        ],
      },
    },
    // KEY: record HTML lives HERE, not on the output records. Captured by
    // computeExtractListDiagnostics as firstContainerHtml on the extraction
    // step's STEP_ITERATION event.
    lastExecutionEvents: [
      { type: 'STEP_ITERATION', stepId: '4', iteration: 1, resultPreview: '{posts:[...]}',
        selectorDiagnostics: [
          { api: 'extractList', containerSelector: 'div[role=article]', containerMatches: 3,
            firstContainerHtml: '<div><span>first post</span><time>2h</time><a href="/u/1">Jane</a></div>' },
        ] },
    ],
  };

  // Mirror exactly what wizard.js's wiring does:
  const wafeFallbackFinalResult = (s) => s.testResult && s.testResult.finalResult;
  const chronicEmpty = detectEmptyOutputFieldsByRatio(
    wafeFallbackFinalResult(wizardState), wizardState.outputSchema,
    { emptyRatioThreshold: 1.0, minRecords: 2 }
  );
  assert.ok(chronicEmpty.length > 0, 'should detect postTime + profileUrl as chronic-empty');
  assert.ok(chronicEmpty.some(f => f.field === 'postTime'), 'postTime should be flagged');

  const lastStepId = wizardState.steps[wizardState.steps.length - 1].id;
  const extractionStepId = findUpstreamExtractionStepId(wizardState.steps, lastStepId);
  assert.strictEqual(extractionStepId, '4', 'should walk back to the extract_posts step');

  const recordHtml = getFirstRecordHtmlFromExecution(wizardState.lastExecutionEvents, extractionStepId);
  assert.ok(recordHtml.includes('<time>2h</time>'),
    'should retrieve firstContainerHtml from executionEvents, got: ' + recordHtml);

  const discoveryResult = discoverFieldCandidates(recordHtml, chronicEmpty.map(f => f.field));
  const block = formatFieldCandidatesBlock(discoveryResult);
  assert.ok(block.startsWith('FIELD CANDIDATES'),
    'should produce non-empty FIELD CANDIDATES block, got: ' + block);
  assert.ok(block.includes('postTime'));
  assert.ok(block.includes('time-like'));
});
