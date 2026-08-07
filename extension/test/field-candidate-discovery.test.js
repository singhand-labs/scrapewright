const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>');
global.DOMParser = dom.window.DOMParser;
global.NodeFilter = dom.window.NodeFilter;
global.Node = dom.window.Node;

const FieldCandidateDiscovery = require('../lib/field-candidate-discovery');

test('module loads and exposes empty api', () => {
  assert.ok(FieldCandidateDiscovery);
  assert.strictEqual(typeof FieldCandidateDiscovery, 'object');
});
