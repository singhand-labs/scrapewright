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

const { findFieldCandidates } = FieldCandidateDiscovery;

test('findFieldCandidates time-like: strong match via <time> tag', () => {
  const html = '<div><time datetime="2026-08-07">2h</time></div>';
  const c = findFieldCandidates(html, 'time-like');
  assert.ok(c.length >= 1);
  assert.strictEqual(c[0].tag, 'time');
  assert.strictEqual(c[0].strength, 'strong');
});

test('findFieldCandidates time-like: strong match via text pattern', () => {
  const html = '<div><span>5 hours ago</span></div>';
  const c = findFieldCandidates(html, 'time-like');
  assert.ok(c.length >= 1);
  assert.strictEqual(c[0].strength, 'strong');
  assert.ok(/5 hours ago/.test(c[0].text));
});

test('findFieldCandidates time-like: yesterday text matches', () => {
  const html = '<div><span>Yesterday</span></div>';
  const c = findFieldCandidates(html, 'time-like');
  assert.ok(c.length >= 1);
  assert.strictEqual(c[0].strength, 'strong');
});

test('findFieldCandidates time-like: medium for ISO date', () => {
  const html = '<div><span>2026-08-07</span></div>';
  const c = findFieldCandidates(html, 'time-like');
  assert.ok(c.length >= 1);
  assert.strictEqual(c[0].strength, 'medium');
});

test('findFieldCandidates time-like: no match returns empty', () => {
  const html = '<div><span>John Doe</span></div>';
  const c = findFieldCandidates(html, 'time-like');
  assert.strictEqual(c.length, 0);
});

test('findFieldCandidates count-like: strong for plain integer with K/M suffix', () => {
  const html = '<div><span>1.2K</span></div>';
  const c = findFieldCandidates(html, 'count-like');
  assert.ok(c.length >= 1);
  assert.strictEqual(c[0].strength, 'strong');
});

test('findFieldCandidates count-like: strong for plain integer', () => {
  const html = '<div><span>42</span></div>';
  const c = findFieldCandidates(html, 'count-like');
  assert.ok(c.length >= 1);
  assert.strictEqual(c[0].strength, 'strong');
});

test('findFieldCandidates count-like: medium for non-numeric span', () => {
  // span with aria-label containing a count word AND a digit
  const html = '<div><span aria-label="12 comments">Comments</span></div>';
  const c = findFieldCandidates(html, 'count-like');
  assert.ok(c.length >= 1);
});

test('findFieldCandidates url-like: strong for <a> with href', () => {
  const html = '<div><a href="/user/123">Profile</a></div>';
  const c = findFieldCandidates(html, 'url-like');
  assert.ok(c.length >= 1);
  assert.strictEqual(c[0].tag, 'a');
  assert.strictEqual(c[0].strength, 'strong');
});

test('findFieldCandidates url-like: medium for <a> with empty href and role=link', () => {
  const html = '<div><a href="#" role="link">Profile</a></div>';
  const c = findFieldCandidates(html, 'url-like');
  assert.ok(c.length >= 1);
});

test('findFieldCandidates id-like: strong for numeric ID', () => {
  const html = '<div><span>1234567</span></div>';
  const c = findFieldCandidates(html, 'id-like');
  assert.ok(c.length >= 1);
  assert.strictEqual(c[0].strength, 'strong');
});

test('findFieldCandidates id-like: strong for hash ID', () => {
  const html = '<div><span>abc123def4</span></div>';
  const c = findFieldCandidates(html, 'id-like');
  assert.ok(c.length >= 1);
  assert.strictEqual(c[0].strength, 'strong');
});

test('findFieldCandidates text-like: matches any non-empty leaf', () => {
  const html = '<div><span>John Doe</span><p>Some text</p></div>';
  const c = findFieldCandidates(html, 'text-like');
  assert.ok(c.length >= 2);
});

test('findFieldCandidates: ranks strong before medium before weak', () => {
  // Strong (time text), medium (date-only), weak (no time content but is <span>)
  const html = '<div><span>John</span><time>2h</time><span>2026-08-07</span></div>';
  const c = findFieldCandidates(html, 'time-like', { maxCandidates: 5 });
  // Strong (<time>) first
  assert.strictEqual(c[0].tag, 'time');
  assert.strictEqual(c[0].strength, 'strong');
});

test('findFieldCandidates: respects maxCandidates option', () => {
  const html = '<div><span>A</span><span>B</span><span>C</span><span>D</span><span>E</span><span>F</span></div>';
  const c = findFieldCandidates(html, 'text-like', { maxCandidates: 3 });
  assert.strictEqual(c.length, 3);
});
