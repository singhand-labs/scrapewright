// Review-stage custom test panel (user request after the fourteenth log):
// phase 5 must offer an inline entry to hand-edit the test input values and
// run more tests, verifying completeness against input conditions the
// research phase never tried (e.g. a more common keyword when the original
// value returned nothing). The run is a TEMPORARY override — the default
// test input is restored afterwards; adopting a new default stays on the
// existing Edit I/O & Test Input path.
//
// wizard.js cannot load in Node — the wiring is pinned by source audit.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'wizard.js'), 'utf8');
const HTML = fs.readFileSync(path.join(__dirname, '..', 'wizard.html'), 'utf8');

describe('custom test panel: wizard.html markup (source audit)', () => {
  it('carries the panel after manualRefinePanel, before phase5Actions', () => {
    const panelAt = HTML.indexOf('id="customTestPanel"');
    const refineAt = HTML.indexOf('id="manualRefinePanel"');
    const actionsAt = HTML.indexOf('id="phase5Actions"');
    assert.ok(refineAt !== -1 && actionsAt !== -1, 'phase-5 anchor panels exist');
    assert.ok(panelAt > refineAt && panelAt < actionsAt, 'customTestPanel sits between manualRefinePanel and phase5Actions');
  });

  it('carries the fields host and the run button', () => {
    assert.ok(HTML.includes('id="customTestFields"'), 'customTestFields present');
    assert.ok(HTML.includes('id="btnCustomTestRun"'), 'btnCustomTestRun present');
  });

  it('uses <details> so the panel is collapsed by default and needs no JS toggle', () => {
    const m = HTML.match(/<details id="customTestPanel"[^>]*>/);
    assert.ok(m, 'panel is a <details> element');
    assert.match(HTML, /<\/details>/);
    assert.ok(!/id="customTestPanel"[^>]*onclick/.test(HTML), 'no inline handler (MV3 CSP)');
  });
});

describe('custom test panel: wizard.js wiring (source audit)', () => {
  it('renderCustomTestFields builds one input per inputSchema property with data-test-key', () => {
    const body = SRC.slice(SRC.indexOf('function renderCustomTestFields('), SRC.indexOf('function collectCustomTestInput('));
    assert.ok(body.length > 50, 'renderCustomTestFields found');
    assert.match(body, /inputSchema\.properties/);
    assert.match(body, /data-test-key|dataset\.testKey/);
    assert.match(body, /wizardState\.testInput/, 'prefills from the current test input');
  });

  it('renderCustomTestFields falls back to a JSON textarea when there are no properties', () => {
    const body = SRC.slice(SRC.indexOf('function renderCustomTestFields('), SRC.indexOf('function collectCustomTestInput('));
    assert.match(body, /customTestJson/);
    assert.match(body, /JSON\.stringify\(wizardState\.testInput/);
  });

  it('collectCustomTestInput coerces number/boolean schema types', () => {
    const body = SRC.slice(SRC.indexOf('function collectCustomTestInput('), SRC.indexOf('async function runCustomTest('));
    assert.ok(body.length > 50, 'collectCustomTestInput found');
    assert.match(body, /input\[data-test-key\]|input\[data-test-key\]/);
    assert.match(body, /Number\(/);
    assert.match(body, /=== 'true'/);
  });

  it('runCustomTest uses the save → override → testScript → restore pattern with try/finally', () => {
    const body = SRC.slice(SRC.indexOf('async function runCustomTest('), SRC.indexOf('async function testScript('));
    assert.ok(body.length > 50, 'runCustomTest found');
    assert.match(body, /const saved = wizardState\.testInput/);
    const ov = body.match(/wizardState\.testInput = custom/);
    assert.ok(ov, 'overrides testInput with the collected custom input');
    assert.match(body, /await testScript\(\)/);
    assert.match(body, /finally\s*\{[\s\S]*?wizardState\.testInput = saved/, 'finally restores the default test input');
  });

  it('runCustomTest disables the button and surfaces the loading overlay while in flight', () => {
    const body = SRC.slice(SRC.indexOf('async function runCustomTest('), SRC.indexOf('async function testScript('));
    assert.match(body, /btn\.disabled = true/);
    assert.match(body, /showLoading\(/);
    assert.match(body, /finally\s*\{[\s\S]*?btn\.disabled = false/, 'finally re-enables the button');
  });

  it('invalid JSON in the fallback textarea is reported, not thrown', () => {
    const body = SRC.slice(SRC.indexOf('async function runCustomTest('), SRC.indexOf('async function testScript('));
    assert.match(body, /=== null[\s\S]{0,200}(appendLog|return)/);
    const collect = SRC.slice(SRC.indexOf('function collectCustomTestInput('), SRC.indexOf('async function runCustomTest('));
    assert.match(collect, /return null/, 'collect returns null on JSON.parse failure');
  });

  it('the run button is wired via addEventListener (no inline handler)', () => {
    assert.match(SRC, /btnCustomTestRun'\)\.addEventListener\('click',\s*(async\s*)?\(\)\s*=>/);
  });

  it('goToPhase(5) re-renders the fields so the prefill tracks the current test input', () => {
    const body = SRC.slice(SRC.indexOf('function goToPhase('), SRC.indexOf('function updateResearchButtonState('));
    assert.match(body, /if \(n === 5\) renderCustomTestFields\(\)/);
  });

  it('no literal maxTokens anywhere in wizard.js (RC53)', () => {
    assert.ok(!/maxTokens:\s*\d+/.test(SRC));
  });
});
