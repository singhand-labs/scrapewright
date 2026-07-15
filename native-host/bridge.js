const { encodeMessage, decodeStream } = require('./lib/native-messaging');
const decoder = decodeStream();

process.stdin.on('data', (chunk) => {
  const messages = decoder(chunk);
  for (const msg of messages) {
    const response = {
      reqId: msg.reqId,
      success: true,
      data: { message: 'stub response' }
    };
    process.stdout.write(encodeMessage(response));
  }
});
