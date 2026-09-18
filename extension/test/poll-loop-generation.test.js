// 2026-09-18 option-page log: after one Reconnect click, TWO long-poll loops
// ran interleaved (sequences f1..f17 and f1..f14, both 5s apart) — the shared
// `pollingActive` boolean let the old loop see `true` (set by the NEW loop)
// after its sleep and continue as a zombie. The fix is a generation token:
// each startLongPolling captures ++pollGeneration and the loop exits when a
// newer generation exists. Source audit (the loop is a chrome-fetch while).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const SRC = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');

test('poll loop is generation-tokened, not boolean-shared', () => {
  assert.match(SRC, /let pollGeneration = 0;/);
  assert.match(SRC, /const myGeneration = \+\+pollGeneration;/);
  assert.match(SRC, /while \(pollingActive && pollGeneration === myGeneration\) \{/);
  // RECONNECT still resets the flag, but the token guarantees the old loop exits
  assert.match(SRC, /pollingActive = false;\s*\n\s*await initCommunication\(\)/);
});
