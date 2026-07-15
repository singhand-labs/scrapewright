function encodeMessage(message) {
  const json = JSON.stringify(message);
  const byteLength = Buffer.byteLength(json, 'utf8');
  const buffer = Buffer.alloc(4 + byteLength);
  buffer.writeUInt32LE(byteLength, 0);
  buffer.write(json, 4, byteLength, 'utf8');
  return buffer;
}

function decodeStream() {
  let buffer = Buffer.alloc(0);
  return function(chunk) {
    buffer = Buffer.concat([buffer, chunk]);
    const messages = [];
    while (buffer.length >= 4) {
      const length = buffer.readUInt32LE(0);
      if (length > 10 * 1024 * 1024) {
        // Discard corrupted frame — length header exceeds 10MB sanity limit
        buffer = Buffer.alloc(0);
        break;
      }
      if (buffer.length < 4 + length) break;
      const json = buffer.slice(4, 4 + length).toString();
      try {
        messages.push(JSON.parse(json));
      } catch {
        // Skip malformed JSON frame but advance buffer to avoid infinite retry
      }
      buffer = buffer.slice(4 + length);
    }
    return messages;
  };
}

module.exports = { encodeMessage, decodeStream };
