const { describe, it } = require('node:test');
const assert = require('node:assert');
const { encodeMessage, decodeStream } = require('../lib/native-messaging');

describe('encodeMessage', () => {
  it('should prepend 4-byte length header', () => {
    const msg = { type: 'ping' };
    const encoded = encodeMessage(msg);
    assert.strictEqual(encoded.readUInt32LE(0), JSON.stringify(msg).length);
    assert.strictEqual(
      encoded.slice(4).toString(),
      JSON.stringify(msg)
    );
  });
});

describe('decodeStream', () => {
  it('should decode complete messages', () => {
    const decoder = decodeStream();
    const msg1 = { type: 'hello' };
    const msg2 = { type: 'world' };
    const data = Buffer.concat([encodeMessage(msg1), encodeMessage(msg2)]);
    const result = decoder(data);
    assert.strictEqual(result.length, 2);
    assert.deepStrictEqual(result[0], msg1);
    assert.deepStrictEqual(result[1], msg2);
  });

  it('should handle partial chunks', () => {
    const decoder = decodeStream();
    const msg = { type: 'test', data: 'x'.repeat(100) };
    const encoded = encodeMessage(msg);
    const part1 = encoded.slice(0, 10);
    const part2 = encoded.slice(10);
    const r1 = decoder(part1);
    assert.strictEqual(r1.length, 0);
    const r2 = decoder(part2);
    assert.strictEqual(r2.length, 1);
    assert.deepStrictEqual(r2[0], msg);
  });
});
