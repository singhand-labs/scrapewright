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
});
