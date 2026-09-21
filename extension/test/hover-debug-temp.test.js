// [HOVER-DEBUG-TEMP] guard tests + REMOVAL CHECKLIST for the temporary
// hover-relay inspection pause. This whole feature is DEBUG-ONLY and must be
// removed once the relay problem is solved.
//
// REMOVAL CHECKLIST (delete each marked block, the storage key, then this file):
//  1. extension/content-script.js — domHover head flag-cache block + the
//     inspection pause block + the MOVED dismiss block comment (4 markers).
//  2. extension/background.js — hoverDebugPending map + initHoverDebugCleanup
//     + HOVER_DEBUG_INSPECT / HOVER_DEBUG_INSPECT_RESPONSE handlers (3 markers).
//  3. extension/wizard.js — showHoverDebugPanel/hide/respond/wire block +
//     the onMessage HOVER_DEBUG_INSPECT_PANEL branch (2 markers).
//  4. extension/wizard.html — #hoverDebugPanel block + #btnHoverDebugToggle
//     (2 markers).
//  5. chrome.storage.local key 'hoverDebugInspect' (toggle button writes it).
//  6. This test file.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const CS = fs.readFileSync(path.join(__dirname, '..', 'content-script.js'), 'utf8');
const BG = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');
const WJ = fs.readFileSync(path.join(__dirname, '..', 'wizard.js'), 'utf8');
const WH = fs.readFileSync(path.join(__dirname, '..', 'wizard.html'), 'utf8');

describe('[HOVER-DEBUG-TEMP] markers present (removal audit)', () => {
  it('content-script has the debug blocks', () => {
    assert.ok((CS.match(/\[HOVER-DEBUG-TEMP\]/g) || []).length >= 4, 'flag cache + pause + dismiss-move markers');
    assert.match(CS, /HOVER_DEBUG_INSPECT'/, 'sends the inspect request');
    assert.match(CS, /hoverDebugInspect/, 'reads the storage flag');
  });
  it('background has the relay + pending map', () => {
    assert.ok((BG.match(/\[HOVER-DEBUG-TEMP\]/g) || []).length >= 2);
    assert.match(BG, /hoverDebugPending/, 'pending map');
    assert.match(BG, /HOVER_DEBUG_INSPECT_RESPONSE/, 'response routing');
  });
  it('wizard has the panel + full-fidelity logging', () => {
    assert.ok((WJ.match(/\[HOVER-DEBUG-TEMP\]/g) || []).length >= 2);
    assert.match(WJ, /HOVER_DEBUG_INSPECT_PANEL/, 'panel message handler');
    assert.match(WJ, /\[hover-debug-relay\]/, 'console log label');
    assert.match(WJ, /mirrorLines\('\[hover-debug-relay\] ' \+ reqId/, 'full-fidelity chunked log');
    assert.ok(WH.includes('hoverDebugPanel') && WH.includes('btnHoverDebugToggle'), 'html panel + toggle');
  });
});

describe('[HOVER-DEBUG-TEMP] behavior contracts', () => {
  it('default OFF — no hardcoded enable (storage-gated only)', () => {
    assert.ok(!/hoverDebugInspect:\s*true/.test(CS) && !/hoverDebugInspect:\s*true/.test(WJ), 'no hardcoded true');
    assert.match(CS, /domHover\.__hoverDebugInspect = false/, 'flag cache starts false');
  });
  it('pause precedes dismiss (popover held open during inspection)', () => {
    const pause = CS.indexOf('HOVER_DEBUG_INSPECT');
    const dismiss = CS.indexOf("type: 'TRUSTED_HOVER_DISMISS'");
    const debugBlock = CS.indexOf('[hover-debug-relay] pause resolved');
    assert.ok(pause !== -1 && dismiss !== -1, 'both present');
    assert.ok(debugBlock < dismiss, 'the inspection pause resolves BEFORE the dismiss is sent');
  });
  it('failure-safe: no receiver / tab closed / storage errors never hang the hover', () => {
    assert.match(CS, /no receiver/, 'content-script no-receiver fallback');
    assert.match(BG, /tab closed/, 'background tab-close cleanup');
  });
});
