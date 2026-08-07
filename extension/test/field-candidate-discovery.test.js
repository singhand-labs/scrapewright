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

const { inferFieldType } = FieldCandidateDiscovery;

test('inferFieldType: time-like via *Time', () => {
  assert.strictEqual(inferFieldType('postTime'), 'time-like');
});

test('inferFieldType: time-like via *Date', () => {
  assert.strictEqual(inferFieldType('publishDate'), 'time-like');
});

test('inferFieldType: time-like via created substring', () => {
  assert.strictEqual(inferFieldType('createdAt'), 'time-like');
});

test('inferFieldType: time-like via updated substring', () => {
  assert.strictEqual(inferFieldType('updatedAt'), 'time-like');
});

test('inferFieldType: count-like via *Count', () => {
  assert.strictEqual(inferFieldType('likeCount'), 'count-like');
});

test('inferFieldType: count-like via plural noun', () => {
  assert.strictEqual(inferFieldType('comments'), 'count-like');
  assert.strictEqual(inferFieldType('likes'), 'count-like');
  assert.strictEqual(inferFieldType('shares'), 'count-like');
});

test('inferFieldType: url-like via *Url', () => {
  assert.strictEqual(inferFieldType('profileUrl'), 'url-like');
  assert.strictEqual(inferFieldType('groupUrl'), 'url-like');
});

test('inferFieldType: url-like via *Link', () => {
  assert.strictEqual(inferFieldType('postLink'), 'url-like');
});

test('inferFieldType: url-like via *Profile', () => {
  assert.strictEqual(inferFieldType('authorProfile'), 'url-like');
});

test('inferFieldType: id-like via *Id', () => {
  assert.strictEqual(inferFieldType('groupId'), 'id-like');
  assert.strictEqual(inferFieldType('postId'), 'id-like');
});

test('inferFieldType: text-like fallback', () => {
  assert.strictEqual(inferFieldType('username'), 'text-like');
  assert.strictEqual(inferFieldType('content'), 'text-like');
  assert.strictEqual(inferFieldType('description'), 'text-like');
});

test('inferFieldType: nested path uses last segment', () => {
  assert.strictEqual(inferFieldType('account.profileUrl'), 'url-like');
  assert.strictEqual(inferFieldType('group.groupMemberCount'), 'count-like');
  assert.strictEqual(inferFieldType('post.createdAt'), 'time-like');
});

test('inferFieldType: id-like does not shadow url-like', () => {
  // profileUrl ends in 'l', not 'id' — but make sure 'Id' inside another word
  // boundary doesn't trigger. 'videoId' → id-like; 'URLId' → url-like wins by priority.
  assert.strictEqual(inferFieldType('videoId'), 'id-like');
});
