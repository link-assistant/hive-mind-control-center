// Pass the 2.45.0 package's src/hive-manager/proxy/test.mjs as an absolute path.
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

const modulePath = process.argv[2];
assert(modulePath, 'Supply the installed manager proxy probe module path');
const { runProxyProbe } = await import(pathToFileURL(modulePath));

// An actual one-pixel PNG and a reply with the PNG signature followed by zeroes.
const photo = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a4h4AAAAASUVORK5CYII=',
  'base64'
);
const invalidReply = Buffer.alloc(24);
photo.copy(invalidReply, 0, 0, 8);

let message;
const client = {
  connect() {},
  checkAuthorization: () => true,
  sendMessage(_recipient, { message: text }) {
    message = { id: 1, message: text };
    return message;
  },
  sendFile() {
    message = { id: 2, media: true };
    return message;
  },
  getMessages: () => [message],
  downloadMedia: () => invalidReply,
  deleteMessages() {},
  destroy() {},
};

assert.deepEqual(await runProxyProbe(client, { photo, timeout: 1 }), {
  text: true,
  document: null,
  photo: 24,
  cleaned: true,
});
console.log('Hive Mind 2.45.0 accepted an invalid 24-byte photo reply.');
