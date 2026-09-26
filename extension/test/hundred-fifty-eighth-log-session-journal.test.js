// extension/test/hundred-fifty-eighth-log-session-journal.test.js
//
// 158th round — user-reported, three rounds of evidence (154/156/157):
// every captured console log (wizard page, service worker, offscreen —
// ALL THREE) showed the same amputation: the first ~13 minutes and the
// last few minutes survived while the middle hours vanished (157th: 152
// lines at 02:xx IDENTICAL across all three files, then a 4-hour gap,
// then the tail). The debug-logger is console-only BY DESIGN (the bugx
// cleanup removed its storage accumulation trusting DevTools capture),
// so the whole diagnostic trail depends on a manual DevTools save that
// demonstrably loses the middle of long sessions — exactly the turns
// where the model authors, verifies, and fails.
//
// Fix under test — the extension owns a durable rolling session journal
// with a one-click merged export:
//   A. lib/session-journal.js — append/cap/drop-oldest-with-marker,
//      session markers, injectable backend (chrome.storage.local by
//      default, memory in tests).
//   B. mirrorLines (the single funnel for every [session] console line)
//      journals every chunk it prints.
//   C. The service worker wraps debugLogger.log into a storage.session
//      ring and answers GET_DEBUG_JOURNAL.
//   D. wizard.html gains a Download Session Log button; the handler
//      merges the page journal with the SW journal and downloads a .log.
//   E. llm-client logContentChunks feeds an optional journal sink so the
//      full LLM bodies (86th-round directive) ride the journal too.
const { test, describe, it } = require('node:test');
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const EXT = path.join(__dirname, '..');
const WJ = fs.readFileSync(path.join(EXT, 'wizard.js'), 'utf8');
const BG = fs.readFileSync(path.join(EXT, 'background.js'), 'utf8');
const HTML = fs.readFileSync(path.join(EXT, 'wizard.html'), 'utf8');
const LLC = fs.readFileSync(path.join(EXT, 'lib', 'llm-client.js'), 'utf8');

describe('158th A — session journal unit', () => {
  const { createSessionJournal } = require('../lib/session-journal');

  function memBackend() {
    let store = [];
    return {
      load: async () => store.slice(),
      save: async (lines) => { store = lines.slice(); }
    };
  }

  it('appends entries with timestamps and round-trips through the backend', async () => {
    const j = createSessionJournal(memBackend(), { maxLines: 100, maxChars: 100000 });
    j.append('mirror', '[session] TOOL verify.run', '{}');
    j.append('mirror', '[session] TOOL RESULT verify.run ok', '{"ok":true}');
    await j.flush();
    const all = await j.all();
    assert.equal(all.length, 2);
    assert.ok(typeof all[0].t === 'number');
    assert.match(all[0].label, /TOOL verify\.run/);
  });

  it('caps the line count, dropping the OLDEST with a disclosure marker', async () => {
    const j = createSessionJournal(memBackend(), { maxLines: 5, maxChars: 1000000 });
    for (let i = 0; i < 9; i++) j.append('mirror', 'L' + i, 'x');
    await j.flush();
    const all = await j.all();
    const payload = all.filter((e) => e.kind !== 'marker');
    assert.ok(payload.length <= 5, 'cap holds at most 5 payload entries (marker may add one)');
    assert.ok(all.some((e) => /journal trimmed/i.test(String(e.label))), 'the drop is disclosed');
    assert.match(all[all.length - 1].label, /L8/, 'newest survives');
    assert.ok(!payload.some((e) => /^L0$/.test(String(e.label))), 'oldest dropped');
  });

  it('session markers ride the journal (start/resume boundaries survive reloads)', async () => {
    const j = createSessionJournal(memBackend(), { maxLines: 100, maxChars: 100000 });
    j.append('mirror', 'before', 'x');
    j.markSessionStart('sess-abc', true);
    j.append('mirror', 'after', 'y');
    const all = await j.all();
    const marker = all.find((e) => e.kind === 'marker');
    assert.ok(marker, 'marker entry present');
    assert.match(marker.label, /sess-abc/);
    assert.match(marker.label, /resume/i, 'the resumed flag rides the marker');
  });
});

describe('158th B — mirrorLines journals every chunk it prints', () => {
  it('the wizard mirror funnel feeds the journal (source audit)', () => {
    const i = WJ.indexOf('function mirrorLines(');
    assert.ok(i > -1);
    const body = WJ.slice(i, WJ.indexOf('function handleSessionEvent', i));
    assert.match(body, /SessionJournal\.append|journalAppend\(/, 'the funnel journals');
    const ci = body.indexOf('console.log(');
    const ji = body.indexOf('SessionJournal.append');
    assert.ok(ci > -1 && ji > -1, 'both console and journal paths present');
  });

  it('session_start marks the journal with the sessionId (source audit)', () => {
    const i = WJ.indexOf("case 'session_start':");
    assert.ok(i > -1);
    const block = WJ.slice(i, i + 1200);
    assert.match(block, /markSessionStart|markJournalSession/, 'the session boundary is journaled');
  });
});

describe('158th C — service worker debug journal', () => {
  it('debugLogger is wrapped into a storage.session ring (source audit)', () => {
    assert.match(BG, /swDebugJournal|SW_DEBUG_JOURNAL_KEY/, 'a SW journal key exists');
    assert.match(BG, /chrome\.storage\.session/, 'persisted in storage.session (survives SW suspension)');
    assert.match(BG, /debugLogger\.log =/, 'the logger is wrapped (no call-site changes needed)');
  });

  it('GET_DEBUG_JOURNAL answers with the ring', () => {
    assert.match(BG, /GET_DEBUG_JOURNAL/, 'the export message type exists');
    const i = BG.indexOf("'GET_DEBUG_JOURNAL'");
    const block = BG.slice(i, i + 800);
    assert.match(block, /sendResponse/, 'responds with the journal');
  });
});

describe('158th D — one-click merged export', () => {
  it('the wizard has a Download Session Log button', () => {
    assert.match(HTML, /btnDownloadSessionLog/, 'button id present');
    assert.match(HTML, /Download Session Log/i, 'label present');
  });

  it('the handler merges the page journal with the SW journal and downloads (source audit)', () => {
    const i = WJ.indexOf('btnDownloadSessionLog');
    assert.ok(i > -1, 'handler wiring exists');
    const block = WJ.slice(i, i + 2500);
    assert.match(block, /GET_DEBUG_JOURNAL/, 'fetches the SW journal');
    assert.match(block, /Blob\(/, 'builds a file');
    assert.match(block, /download/, 'triggers a download');
  });
});

describe('158th E — llm-client full bodies ride the journal', () => {
  it('logContentChunks feeds the optional journal sink', () => {
    const i = LLC.indexOf('function logContentChunks');
    const body = LLC.slice(i, i + 900);
    assert.match(body, /__scrapewrightJournalSink|journalSink/, 'an optional sink hook exists');
  });
});
