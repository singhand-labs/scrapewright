// Regression for console.log 2026-08-23 (FB search wizard session): step 4
// ($extractWithHover, 5-container batch) was killed by a bare
// 'SCRIPT_TIMEOUT' after 60.8s. The autoFix LLM received no budget number
// and no remedy direction, so it could not respond to the actual cause.
// These tests verify both executor throw sites carry the budget figure and
// batch-narrowing guidance while keeping 'SCRIPT_TIMEOUT' as the leading
// token (background.js matches with .includes()).

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const ORIG_CHROME = global.chrome;
const ORIG_DEBUG_LOGGER = global.debugLogger;

function mockChrome() {
  return {
    runtime: {
      onMessage: { addListener() {}, removeListener() {} },
      sendMessage: async () => {},
      getContexts: async () => [{}],
      getURL: (p) => `chrome-extension://fake/${p}`
    },
    offscreen: {},
    tabs: { sendMessage: async () => {} }
  };
}

async function captureRejection(promise) {
  try {
    await promise;
    throw new Error('expected rejection, got resolution');
  } catch (err) {
    return err;
  }
}

describe('SCRIPT_TIMEOUT error context', () => {
  describe('OffscreenExecutor (primary path)', () => {
    const { OffscreenExecutor } = require('../lib/offscreen-executor');

    beforeEach(() => { global.chrome = mockChrome(); });

    it('rejects with budget ms in the message', async () => {
      const ex = new OffscreenExecutor(1);
      ex.timeoutMs = 25;
      const err = await captureRejection(ex.execute('await new Promise(() => {})', {}));
      assert.match(err.message, /^SCRIPT_TIMEOUT/);
      assert.match(err.message, /25ms/);
    });

    it('points the LLM at containerRange / maxIterations slicing for hover batches', async () => {
      const ex = new OffscreenExecutor(2);
      ex.timeoutMs = 25;
      const err = await captureRejection(ex.execute('await new Promise(() => {})', {}));
      assert.match(err.message, /containerRange|maxContainers/);
      assert.match(err.message, /maxIterations/);
      assert.match(err.message, /extractWithHover|\$hover/);
    });
  });
});
