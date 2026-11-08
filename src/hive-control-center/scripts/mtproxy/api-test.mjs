#!/usr/bin/env node
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const { TelegramClient, sessions, Api } = require('teleproto');
const { createHash } = require('node:crypto');

const args = process.argv.slice(2);
const options = {
  host: process.env.MTPROXY_HOST || '',
  port: process.env.MTPROXY_PORT || '443',
  secret: process.env.MTPROXY_SECRET_KEY || '',
  secretFile: process.env.MTPROXY_SECRET_FILE || '',
  envFile: process.env.TELEGRAM_ENV_FILE || '',
  sessionFile: process.env.TELEGRAM_SESSION_FILE || '',
  apiId: process.env.TELEGRAM_API_ID || '',
  apiHash: process.env.TELEGRAM_API_HASH || '',
  lenvFile: process.env.MTPROXY_LENV_FILE || './.lenv',
  keep: false,
  media: process.env.MTPROXY_API_MEDIA === '1',
};

for (let i = 0; i < args.length; i += 1) {
  const arg = args[i];
  const next = () => {
    const value = args[++i];
    if (value === undefined) throw new Error(`missing value for ${arg}`);
    return value;
  };
  if (arg === '--help' || arg === '-h') {
    console.log(`Usage: node api-test.mjs [options]

Connects to Telegram over MTProto through the proxy, sends a marker message to
Saved Messages, reads it back, and prints only status lines (never credentials).

Options:
  --host <host>             Proxy host (default: MTPROXY_HOST or SERVER_IP in .lenv)
  --port <port>             Proxy port (default: MTPROXY_PORT or 443)
  --secret <hex>            32-hex proxy key (prefer MTPROXY_SECRET_KEY)
  --secret-file <path>      File containing the 32-hex proxy key
  --env-file <path>         Telegram credentials .env file
  --session-file <path>     GramJS StringSession file
  --api-id <id>             Telegram API ID
  --api-hash <hash>         Telegram API hash
  --lenv <path>             .lenv used for SERVER_IP/MTPROXY_PORT (default: ./.lenv)
  --keep                    Keep the marker messages in Saved Messages
  --media                   Also upload and download a small document
  -h, --help                Show this help

The session file must belong to the same API ID/hash. Never commit .env,
.telegram_session, .lenv, or the proxy secret.
`);
    process.exit(0);
  } else if (arg === '--host') options.host = next();
  else if (arg === '--port') options.port = next();
  else if (arg === '--secret') options.secret = next();
  else if (arg === '--secret-file') options.secretFile = next();
  else if (arg === '--env-file') options.envFile = next();
  else if (arg === '--session-file') options.sessionFile = next();
  else if (arg === '--api-id') options.apiId = next();
  else if (arg === '--api-hash') options.apiHash = next();
  else if (arg === '--lenv') options.lenvFile = next();
  else if (arg === '--keep') options.keep = true;
  else if (arg === '--media') options.media = true;
  else throw new Error(`unknown option: ${arg}`);
}

const trim = (value) => String(value ?? '').trim().replace(/^['"]|['"]$/g, '');
const parseEnv = (file) => {
  const values = {};
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z0-9_]+)\s*[:=]\s*(.*?)\s*$/);
    if (!match || match[2].startsWith('#')) continue;
    values[match[1]] = trim(match[2]);
  }
  return values;
};

const lenv = (() => {
  try {
    return parseEnv(resolve(options.lenvFile));
  } catch {
    return {};
  }
})();
options.host = trim(options.host || lenv.SERVER_IP);
options.port = trim(options.port || lenv.MTPROXY_PORT || '443');
options.secret = trim(options.secret);
if (!options.secret && options.secretFile) {
  options.secret = readFileSync(options.secretFile, 'utf8');
}
options.secret = options.secret.trim();
if (!options.host) throw new Error('proxy host is required (--host or SERVER_IP in .lenv)');
if (!/^[0-9]+$/.test(options.port) || Number(options.port) < 1 || Number(options.port) > 65535) {
  throw new Error(`invalid proxy port: ${options.port}`);
}
if (!/^[0-9a-f]{32}$/i.test(options.secret)) {
  throw new Error('proxy secret must be a 32-hex key (set MTPROXY_SECRET_KEY or --secret-file)');
}

const env = options.envFile ? parseEnv(resolve(options.envFile)) : {};
options.apiId = trim(options.apiId || env.TELEGRAM_API_ID);
options.apiHash = trim(options.apiHash || env.TELEGRAM_API_HASH);
options.sessionFile = trim(
  options.sessionFile || (options.envFile ? resolve(dirname(options.envFile), '.telegram_session') : ''),
);
if (!options.apiId || !options.apiHash) {
  throw new Error('Telegram API ID/hash are required (--env-file or TELEGRAM_API_ID/TELEGRAM_API_HASH)');
}
if (!options.sessionFile) throw new Error('session file is required (--session-file or TELEGRAM_SESSION_FILE)');
const session = readFileSync(options.sessionFile, 'utf8').trim();
if (!session) throw new Error('session file is empty');

const marker = `mtproxy-api-test ${new Date().toISOString()} ${randomBytes(4).toString('hex')}`;
const redact = (text) =>
  String(text ?? '')
    .replaceAll(options.secret, '<redacted>')
    .replaceAll(options.apiHash, '<redacted>')
    .replaceAll(session, '<redacted>');

const client = new TelegramClient(
  new sessions.StringSession(session),
  Number(options.apiId),
  options.apiHash,
  {
    connectionRetries: 3,
    floodSleepThreshold: 0,
    proxy: {
      ip: options.host,
      port: Number(options.port),
      MTProxy: true,
      secret: `dd${options.secret}`,
    },
  },
);

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
  'base64',
);
const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');

let status = 'FAIL';
const sentIds = [];
try {
  await client.connect();
  const me = await client.getMe();
  const user = me.username ? `@${me.username}` : String(me.id);
  console.log(`API_TEST_CONNECTED=yes user=${user}`);
  const sent = await client.sendMessage('me', { message: marker });
  if (sent?.id) sentIds.push(sent.id);
  const messages = await client.getMessages('me', { limit: 5 });
  const verified = messages.some((message) => message.message === marker);
  console.log(`API_TEST_SENT=yes saved_messages_verified=${verified ? 'yes' : 'no'} marker=${marker}`);
  if (!verified) throw new Error('sent message was not found in Saved Messages');

  if (options.media) {
    const caption = `${marker} media`;
    const mediaMessage = await client.sendFile('me', {
      file: png,
      caption,
      forceDocument: true,
      attributes: [new Api.DocumentAttributeFilename({ fileName: 'api-media-test.png' })],
    });
    if (mediaMessage?.id) sentIds.push(mediaMessage.id);
    console.log(`API_TEST_MEDIA_SENT=yes bytes=${png.length}`);
    const mediaMessages = await client.getMessages('me', { limit: 5 });
    const received = mediaMessages.find(
      (message) => message.id === mediaMessage.id || message.message === caption,
    );
    if (!received?.media) throw new Error('sent media was not found in Saved Messages');
    const downloaded = await client.downloadMedia(received, {});
    if (!Buffer.isBuffer(downloaded)) throw new Error('media download did not return a buffer');
    const uploadedSha = sha256(png);
    const downloadedSha = sha256(downloaded);
    const mediaVerified = uploadedSha === downloadedSha && downloaded.length === png.length;
    console.log(
      `API_TEST_MEDIA_DOWNLOADED=yes bytes=${downloaded.length} verified=${mediaVerified ? 'yes' : 'no'}`,
    );
    if (!mediaVerified) throw new Error('downloaded media does not match the uploaded document');
  }

  if (options.keep) {
    console.log('API_TEST_KEPT=yes');
  } else if (sentIds.length) {
    await client.deleteMessages('me', sentIds, { revoke: true });
    console.log('API_TEST_CLEANED=yes');
  }
  status = 'PASS';
} catch (error) {
  console.error(`API_TEST_ERROR=${redact(error?.message || error)}`);
  process.exitCode = 1;
} finally {
  if (!options.keep && sentIds.length) {
    await client.deleteMessages('me', sentIds, { revoke: true }).catch(() => {});
  }
  await client.disconnect().catch(() => {});
  console.log(`API_TEST_STATUS=${status}`);
}
