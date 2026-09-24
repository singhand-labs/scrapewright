// extension/test/hundred-forty-second-log-stuffed-decoy.test.js
//
// 142nd log (the round-141 user test): the first fully-green quality run
// (7/7 UNIQUE posts, postTime 7/7 absolute, likes parsed to bare numbers —
// the 139th/140th gates all held) still shipped one record whose content was
// anti-scrape COMMA-STUFFED text: CJK prose with ASCII punctuation
// interleaved mid-word ("張柏,芝沒,穿內,,衣…"). The decoy layer stuffs ASCII
// commas/exclamations DIRECTLY BETWEEN CJK characters; legitimate Chinese
// uses fullwidth "，" and ASCII lists comma-SPACE-separate LATIN words, so
// >=5 ASCII marks each sandwiched by CJK on both sides is the signature.
// Added as a detectJunkValues kind ('obfuscatedText') — riding the existing
// report + REQUIRED-promotion (JUNK_VALUES_REQUIRED) + finish-disclosure
// lanes. Uniquely REPAIRABLE junk: the clean value is the same string minus
// the stuffed marks.
//
// No site tokens.
const { test, describe, it } = require('node:test');
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');

const VR_SRC = fs.readFileSync(path.join(__dirname, '..', 'lib', 'verify-runner.js'), 'utf8');

// The verify-runner IIFE cannot require() cleanly (it resolves wizard-utils),
// so slice detectJunkValues + its helpers into a vm with stubs.
function loadJunkDetector() {
  const ctx = {
    console: { log: () => {}, warn: () => {}, error: () => {} },
    WU: {
      schemaItemRequiredForPath: () => []
    },
    window: {},
    self: {},
    global: null,
    module: { exports: {} },
    Array, Object, String, Number, Boolean, Math, RegExp, JSON, Set, Map, Promise, Date
  };
  ctx.global = ctx;
  vm.createContext(ctx);
  // stub resolveLib + resolveWU surfaces the IIFE touches at load
  vm.runInContext('function require(p){ return WU; }', ctx);
  const start = VR_SRC.indexOf('const URLISH_FIELD');
  const end = VR_SRC.indexOf('// Thirty-third log D3');
  assert.ok(start > -1 && end > start, 'detector region found');
  const region = VR_SRC.slice(start, end) + '\nthis.__detect = detectJunkValues;';
  vm.runInContext(region, ctx);
  return ctx.__detect;
}

const STUFFED = '張柏,芝沒,穿內,,衣只穿吊帶睡衣與,,兒,子互動導致「走,光,露!,點';
const SCHEMA = { type: 'object', properties: { posts: { type: 'array', items: { type: 'object',
  properties: { content: { type: 'string' }, likes: { type: 'string' } } } } } };

describe('142nd log — comma-stuffed decoy text lands in the junk lanes', () => {
  it('a record with stuffed CJK content is flagged kind obfuscatedText with the sample', () => {
    const detect = loadJunkDetector();
    const out = detect({ posts: [
      { content: STUFFED, likes: '92' },
      { content: STUFFED, likes: '3.5K' }
    ] }, SCHEMA);
    assert.ok(out, 'census fires');
    const hit = out.fields.find((f) => f.kind === 'obfuscatedText');
    assert.ok(hit, 'obfuscatedText entry present');
    assert.equal(hit.field, 'posts.content');
    assert.equal(hit.count, 2);
    assert.match(hit.sample, /張柏/);
  });

  it('legitimate text is NOT flagged: fullwidth-comma lists, ASCII English lists, short casual enumerations, clean prose', () => {
    const detect = loadJunkDetector();
    const clean = { posts: [
      { content: '蘋果，香蕉，橙子，西瓜，芒果，草莓，檸檬，葡萄，荔枝，龍眼', likes: '1' },
      { content: 'apple, banana, cherry, orange, melon, peach, plum, apricot', likes: '2' },
      { content: '今天,明天,後天都要上班', likes: '3' },
      { content: '成熟知性，豐滿迷人，這是跨年晚會最好的一段表演', likes: '4' },
      { content: '#美女 #小姐姐', likes: '5' }
    ] };
    const out = detect(clean, SCHEMA);
    assert.ok(!out || !out.fields.some((f) => f.kind === 'obfuscatedText'),
      'no obfuscatedText hits on legitimate text — got ' + JSON.stringify(out && out.fields));
  });

  it('the REQUIRED promotion inherits the new kind automatically (source pin: JUNK_VALUES_REQUIRED loop does not exclude it)', () => {
    // the 127th veto loop skips only kind==='controlLabel'
    const i = VR_SRC.indexOf("jk.kind === 'controlLabel') continue;");
    assert.ok(i > -1, 'the controlLabel exclusion exists');
    const loop = VR_SRC.slice(i - 400, i + 400);
    assert.ok(!/obfuscatedText.{0,60}continue/.test(loop), 'obfuscatedText is NOT excluded from the required-veto');
    assert.match(VR_SRC, /kind: 'obfuscatedText'/, 'kind emitted');
    assert.match(VR_SRC, /stuffedMarkCount/, 'the discriminator exists');
  });

  it('discriminator thresholds: >=5 sandwiched marks, length >=12', () => {
    const detect = loadJunkDetector();
    // 4 marks — below the bar
    const four = '張柏,芝沒,穿內,衣只,穿吊帶';
    const out = detect({ posts: [{ content: four, likes: '1' }] }, SCHEMA);
    assert.ok(!out || !out.fields.some((f) => f.kind === 'obfuscatedText'), '4 marks is not flagged');
  });
});
