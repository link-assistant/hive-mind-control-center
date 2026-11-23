// Pass the pinned 2.48.0 package's src/hive-manager/proxy/test.mjs as an absolute path.
import assert from 'node:assert/strict';
import { pathToFileURL, URL } from 'node:url';

const modulePath = process.argv[2];
assert(modulePath, 'Supply the installed manager proxy probe module path');
const moduleUrl = pathToFileURL(modulePath);
const { runProxyProbe } = await import(moduleUrl);
const { createProbePhoto } = await import(new URL('./photo.mjs', moduleUrl));

// Keep the uploaded photo valid and return only the PNG signature and zeroes.
const photo = createProbePhoto();
const invalidReply = Buffer.alloc(24);
photo.copy(invalidReply, 0, 0, 8);

let message;
let deleted;
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
  deleteMessages(_recipient, ids) {
    deleted = ids;
  },
  destroy() {},
};

await assert.rejects(
  () => runProxyProbe(client, { photo, timeout: 1 }),
  /Could not decode a bounded JPEG or PNG probe photo/
);
assert.deepEqual(deleted, [1, 2]);
console.log('The pinned manager rejected an invalid 24-byte photo reply.');
