// extension/test/opentab-envelope-unwrap.test.js
//
// Seventeenth log (2026-09-03): $openTab resolved the OffscreenExecutor
// envelope {result, selectorDiagnostics} instead of the fn body's return
// value — a DAY-ONE bug in handleOpenTabExecute (`const result = await
// executor.execute(...)` resolves the envelope, which was then sent as
// TAB_RESULT.result verbatim). Consequences in the log: v4 `recs.slice is
// not a function`, v5's defensive `[recs]` coercion wrapped the WRAPPER
// object → a single all-empty record while the real extracted array sat
// discarded at .result. The shipped examples (sam.gov.json,
// wuhu.etrading.cn.json) read `detail.title` directly off the return —
// silently degraded by the same leak since release.
//
// The relay spans the MV3 service worker, so this is a source audit pin
// (same pattern as test/rc16-output-pages-list.test.js).
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');

const SRC = readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');

describe('$openTab envelope unwrap (seventeenth log: day-one wrapper leak)', () => {
  const fnStart = SRC.indexOf('async function handleOpenTabExecute(');
  const body = fnStart === -1 ? '' : SRC.slice(fnStart);

  it('handleOpenTabExecute exists', () => {
    assert.notEqual(fnStart, -1);
  });

  it('the executor call names its value envelope (self-documenting unwrap site)', () => {
    assert.match(body, /const envelope = await executor\.execute\(/,
      'the resolved value must be named for what it is — the {result, selectorDiagnostics} envelope');
  });

  it('success-path TAB_RESULT sends the fn return value, not the envelope', () => {
    const tryStart = body.indexOf('const envelope = await executor.execute(');
    const catchStart = body.indexOf('} catch (error)', tryStart);
    const tryBody = body.slice(tryStart, catchStart);
    assert.ok(tryBody.length > 0, 'success try-block found');
    assert.match(tryBody, /type:\s*'TAB_RESULT',\s*reqId,\s*result:\s*envelope\.result/,
      'TAB_RESULT payload unwraps the envelope — $openTab must resolve the fn body\'s return value');
    assert.doesNotMatch(tryBody, /result:\s*envelope\b(?!\.result)/,
      'the raw envelope must never ride TAB_RESULT.result again');
  });

  it('failure-path TAB_RESULT still carries subTabSnapshot (autoFix depends on it)', () => {
    assert.match(body, /TAB_RESULT[\s\S]{0,400}subTabSnapshot/);
  });
});

// 181st round (live recurrence across two sites: $openTab resolved
// null/undefined with 9-15ms sub-tab "completions" — the fn body contains
// multi-second waits, so it never ran). glm-5.2 emits MINIFIED arrows with
// no space after async: async()=>{...}. The 97th-round shape regex required
// async\s+ (one-plus whitespace), so exactly that shape fell through to the
// never-invoked body wrap. The table pins every real fn.toString() shape.
describe('181st round: full-fn-source detection covers minified arrows', () => {
  const fs181 = require('node:fs');
  const path181 = require('node:path');
  const BG181 = fs181.readFileSync(path181.join(__dirname, '../background.js'), 'utf8');
  const m181 = BG181.match(/const isFullFnSource = (\/.+\/)\.test\(fnSource\)/);
  assert.ok(m181, 'detection regex found in background.js');
  const re181 = eval(m181[1]);

  it('the live failing shape async()=>{...} is detected as a full source', () => {
    assert.equal(re181.test('async()=>{await $wait("body",3000);return 1}'), true,
      'the 181st incident: no space after async fell to the never-invoked wrap');
  });

  it('every real fn.toString() shape is detected', () => {
    for (const src of [
      'async () => {return 1}',
      'async(a)=>{return 1}',
      '()=>{return 1}',
      '(a)=>{return 1}',
      'async url=>{return 1}',
      'url=>{return 1}',
      'function(){return 1}',
      'async function(){return 1}',
      'async function named(){return 1}'
    ]) {
      assert.equal(re181.test(src), true, 'shape must be detected: ' + src);
    }
  });

  it('legacy bare-body sources still take the body wrap', () => {
    for (const src of ['const x = await $(sel); return x;', 'return 1;', 'await $wait("body"); return {};']) {
      assert.equal(re181.test(src), false, 'body-shaped source must NOT be detected: ' + src);
    }
  });
});
