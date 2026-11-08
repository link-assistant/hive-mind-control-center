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
  appConfig: process.env.TELEGRAM_APP_CONFIG || '',
  noProxy: false,
  keep: false,
  media: process.env.MTPROXY_API_MEDIA === '1',
  receiveMedia: process.env.MTPROXY_API_RECEIVE_MEDIA === '1',
  receiveProfile: process.env.MTPROXY_API_RECEIVE_PROFILE || '',
  chat: process.env.MTPROXY_API_CHAT || '@telegram',
  receiveLimit: Number(process.env.MTPROXY_API_RECEIVE_LIMIT || '50'),
  relaxPing: process.env.MTPROXY_API_RELAX_PING === '1',
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
  --secret <value>          32-hex proxy key or full ee... FakeTLS secret
  --secret-file <path>      File containing the 32-hex proxy key
  --env-file <path>         Telegram credentials .env file
  --session-file <path>     GramJS StringSession file
  --api-id <id>             Telegram API ID
  --api-hash <hash>         Telegram API hash
  --lenv <path>             .lenv used for SERVER_IP/MTPROXY_PORT (default: ./.lenv)
  --app-config <path>       Telegram accounts-shared-data file with the proxy secret
  --no-proxy                Connect directly, bypassing the proxy (diagnosis only)
  --keep                    Keep the marker messages in Saved Messages
  --media                   Also upload and download a small document
  --receive-media           Download the latest photo from --chat (receive only)
  --receive-profile <peer>  Download a profile photo (receive-only diagnostic)
  --chat <peer>             Chat for --receive-media (default: @telegram)
  --receive-limit <n>       Messages to scan for a photo (default: 50)
  --relax-ping              Raise the diagnostic ping timeout (slow media)
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
  else if (arg === '--app-config') options.appConfig = next();
  else if (arg === '--no-proxy') options.noProxy = true;
  else if (arg === '--keep') options.keep = true;
  else if (arg === '--media') options.media = true;
  else if (arg === '--receive-media') options.receiveMedia = true;
  else if (arg === '--receive-profile') options.receiveProfile = next();
  else if (arg === '--chat') options.chat = next();
  else if (arg === '--receive-limit') options.receiveLimit = Number(next());
  else if (arg === '--relax-ping') options.relaxPing = true;
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
if (!options.secret && options.appConfig) {
  const appConfig = JSON.parse(readFileSync(options.appConfig, 'utf8'));
  const proxy = appConfig.proxy && typeof appConfig.proxy === 'object' ? appConfig.proxy : appConfig;
  const encoded = String(proxy.secret ?? '');
  const hex = Buffer.from(encoded, 'base64').toString('hex');
  const prefix = hex.slice(0, 2).toLowerCase();
  options.secret = prefix === 'ee' ? hex : prefix === 'dd' ? hex.slice(2) : hex;
}
options.secret = options.secret.trim();
const isFakeTls = /^ee[0-9a-f]{32}[0-9a-f]+$/i.test(options.secret);
if (!options.noProxy) {
  if (!options.host) throw new Error('proxy host is required (--host or SERVER_IP in .lenv)');
  if (!/^[0-9]+$/.test(options.port) || Number(options.port) < 1 || Number(options.port) > 65535) {
    throw new Error(`invalid proxy port: ${options.port}`);
  }
  if (!isFakeTls && !/^[0-9a-f]{32}$/i.test(options.secret)) {
    throw new Error('proxy secret must be a 32-hex key or a full ee... FakeTLS secret');
  }
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
if (!Number.isInteger(options.receiveLimit) || options.receiveLimit < 1 || options.receiveLimit > 200) {
  throw new Error(`invalid receive limit: ${options.receiveLimit}`);
}
const session = readFileSync(options.sessionFile, 'utf8').trim();
if (!session) throw new Error('session file is empty');

const marker = `mtproxy-api-test ${new Date().toISOString()} ${randomBytes(4).toString('hex')}`;
const redact = (text) => {
  let output = String(text ?? '');
  for (const value of [options.secret, options.apiHash, session]) {
    if (value) output = output.replaceAll(value, '<redacted>');
  }
  return output;
};

if (options.relaxPing) {
  const { Session } = require('teleproto/network/session/Session');
  const timers = Session.prototype.timers;
  Session.prototype.timers = function (now) {
    const values = timers.call(this, now);
    return {
      ...values,
      pingDisconnect: Math.max(values.pingDisconnect, 60),
      readDisconnect: Math.max(values.readDisconnect, 60),
    };
  };
}

const client = new TelegramClient(
  new sessions.StringSession(session),
  Number(options.apiId),
  options.apiHash,
  {
    connectionRetries: 3,
    floodSleepThreshold: 0,
    ...(options.noProxy
      ? {}
      : {
          proxy: {
            ip: options.host,
            port: Number(options.port),
            MTProxy: true,
            secret: isFakeTls ? options.secret.toLowerCase() : `dd${options.secret}`,
          },
        }),
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

  if (options.receiveProfile) {
    const downloadedPhoto = await client.downloadProfilePhoto(options.receiveProfile, {});
    const isJpeg =
      Buffer.isBuffer(downloadedPhoto) &&
      downloadedPhoto.length > 3 &&
      downloadedPhoto[0] === 0xff &&
      downloadedPhoto[1] === 0xd8 &&
      downloadedPhoto[2] === 0xff;
    const isPng =
      Buffer.isBuffer(downloadedPhoto) &&
      downloadedPhoto.length > 8 &&
      downloadedPhoto.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    console.log(
      `API_TEST_RECEIVE_PROFILE_DOWNLOADED=yes peer=${options.receiveProfile} bytes=${downloadedPhoto?.length || 0} verified=${isJpeg || isPng ? 'yes' : 'no'}`,
    );
    if (!(isJpeg || isPng)) throw new Error('profile photo download did not return a JPEG or PNG');
  } else if (options.receiveMedia) {
    const candidates = await client.getMessages(options.chat, { limit: options.receiveLimit });
    const receivedPhoto = candidates.find((message) => message && message.photo);
    if (!receivedPhoto) throw new Error(`no photo found in ${options.chat}`);
    console.log(
      `API_TEST_RECEIVE_MEDIA_FOUND=yes chat=${options.chat} message_id=${receivedPhoto.id}`,
    );
    const downloadedPhoto = await client.downloadMedia(receivedPhoto, {});
    const isJpeg =
      Buffer.isBuffer(downloadedPhoto) &&
      downloadedPhoto.length > 3 &&
      downloadedPhoto[0] === 0xff &&
      downloadedPhoto[1] === 0xd8 &&
      downloadedPhoto[2] === 0xff;
    const isPng =
      Buffer.isBuffer(downloadedPhoto) &&
      downloadedPhoto.length > 8 &&
      downloadedPhoto.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const photoVerified = isJpeg || isPng;
    console.log(
      `API_TEST_RECEIVE_MEDIA_DOWNLOADED=yes chat=${options.chat} bytes=${downloadedPhoto?.length || 0} verified=${photoVerified ? 'yes' : 'no'}`,
    );
    if (!photoVerified) throw new Error('received media download did not return a JPEG or PNG');
  } else {
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

    const photo = Buffer.from(png);
    photo.name = 'api-media-test.png';
    const photoCaption = `${marker} photo`;
    const photoMessage = await client.sendFile('me', { file: photo, caption: photoCaption });
    if (photoMessage?.id) sentIds.push(photoMessage.id);
    console.log('API_TEST_PHOTO_SENT=yes');
    const photoMessages = await client.getMessages('me', { limit: 5 });
    const receivedPhoto = photoMessages.find(
      (message) => message.id === photoMessage.id || message.message === photoCaption,
    );
    if (!receivedPhoto?.media) throw new Error('sent photo was not found in Saved Messages');
    const downloadedPhoto = await client.downloadMedia(receivedPhoto, {});
    const photoVerified =
      Buffer.isBuffer(downloadedPhoto) &&
      downloadedPhoto.length > 3 &&
      downloadedPhoto[0] === 0xff &&
      downloadedPhoto[1] === 0xd8 &&
      downloadedPhoto[2] === 0xff;
    if (!photoVerified) throw new Error('photo download did not return a JPEG');
    console.log(`API_TEST_PHOTO_DOWNLOADED=yes bytes=${downloadedPhoto.length} verified=yes`);
  }
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
