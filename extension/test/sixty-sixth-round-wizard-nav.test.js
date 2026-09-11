// 用户报告（2026-09-11 晚）：wizard Back 跳转是老版本链路。按 PHASE_LABELS
// 舞台模型修正：主线 1→4→5；2/3 为 Review 伞下子屏，从 review 进入时
// Back 应回 review（reviewFromPhase5）；研究屏（4）Back 回需求屏（1）。
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('node:path');
const SRC = fs.readFileSync(path.join(__dirname, '..', 'wizard.js'), 'utf8');

describe('wizard Back navigation follows the stage model', () => {
  it('phase 3 (Edit I/O sub-screen) Back returns to the review when entered from it', () => {
    const i = SRC.indexOf("getElementById('btnPhase3Back')");
    assert.match(SRC.slice(i, i + 140), /goToPhase\(reviewFromPhase5 \? 5 : 2\)/);
  });
  it('phase 4 (AI Research) Back goes to Requirements, not the legacy 3', () => {
    const i = SRC.indexOf("getElementById('btnPhase4Back')");
    assert.match(SRC.slice(i, i + 120), /goToPhase\(1\)/);
    assert.ok(!/goToPhase\(3\)/.test(SRC.slice(i, i + 120)));
  });
  it('phase 2 Back keeps the review-or-requirements branch', () => {
    const i = SRC.indexOf("getElementById('btnPhase2Back')");
    assert.match(SRC.slice(i, i + 140), /goToPhase\(reviewFromPhase5 \? 5 : 1\)/);
  });
});
