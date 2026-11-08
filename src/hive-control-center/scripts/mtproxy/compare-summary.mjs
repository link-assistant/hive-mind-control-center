#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const SUMMARY_FIELDS = [
  ['client.app.status', 'client app proxy status'],
  ['client.app.noResponseNew', 'client app new transport errors'],
  ['client.app.noResponseTotal', 'client app historical transport errors'],
  ['client.app.resumes', 'client app resume lines'],
  ['client.sockets.established', 'client established sockets'],
  ['client.sockets.sendqMax', 'client max Send-Q'],
  ['client.sockets.recvqMax', 'client max Recv-Q'],
  ['client.media.partial', 'client partial media files'],
  ['client.media.bytes', 'client partial media bytes'],
  ['client.media.growth', 'client partial media growth'],
  ['client.media.finalGrowth', 'client final media growth'],
  ['client.media.recent', 'client recent complete media'],
  ['client.api.status', 'client API status'],
  ['client.capture.ok', 'client capture available'],
  ['client.capture.sentBytes', 'client capture sent bytes'],
  ['client.capture.recvBytes', 'client capture received bytes'],
  ['client.capture.sentRetransmits', 'client capture sent retransmits'],
  ['client.capture.recvRetransmits', 'client capture received retransmits'],
  [
    'client.capture.recvRetransmitBytes',
    'client capture received retransmit bytes',
  ],
  ['client.capture.recvAckGapMax', 'client capture receive ACK gap max'],
  ['client.capture.recvAckGapFlows', 'client capture receive ACK gap flows'],
  ['client.capture.sentRst', 'client capture sent RST'],
  ['client.capture.recvRst', 'client capture received RST'],
  ['server.listening', 'server listening sockets'],
  ['server.workers', 'server workers setting'],
  ['server.nofile', 'server nofile setting'],
  ['server.clientConns', 'server client connections'],
  ['server.active', 'server payload-carrying client connections'],
  ['server.noPayload', 'server handshake-only client connections'],
  ['server.dc', 'server Telegram DC connections'],
  ['server.sendqMax', 'server max client Send-Q'],
  ['server.bytesReceived', 'server bytes received from clients'],
  ['server.bytesSent', 'server bytes sent to clients'],
  ['server.dc2Main', 'server DC2 main connections'],
  ['server.dc2MainActive', 'server DC2 main payload connections'],
  ['server.mssRules', 'server TCPMSS rules'],
  ['server.capture.ok', 'server capture available'],
  ['server.capture.clientBytes', 'server capture client bytes'],
  ['server.capture.proxyBytes', 'server capture proxy bytes'],
  ['server.capture.clientRetransmits', 'server capture client retransmits'],
  ['server.capture.proxyRetransmits', 'server capture proxy retransmits'],
  [
    'server.capture.proxyRetransmitBytes',
    'server capture proxy retransmit bytes',
  ],
  ['server.capture.proxyAckGapMax', 'server capture proxy ACK gap max'],
  ['server.capture.proxyAckGapFlows', 'server capture proxy ACK gap flows'],
  ['server.capture.clientRst', 'server capture client RST'],
  ['server.capture.proxyRst', 'server capture proxy RST'],
  ['knownGood.status', 'known-good status'],
  ['knownGood.mismatches', 'known-good mismatches'],
  ['result.status', 'overall result'],
];

const getPath = (object, path) =>
  path
    .split('.')
    .reduce((value, key) => (value == null ? undefined : value[key]), object);

export const flattenSummary = (summary) => {
  const flat = {};
  for (const [key] of SUMMARY_FIELDS) {
    const value = getPath(summary, key);
    flat[key] = value === undefined ? null : value;
  }
  return flat;
};

export const compareSummaries = (before, after) => {
  const left = flattenSummary(before);
  const right = flattenSummary(after);
  return SUMMARY_FIELDS.map(([key, label]) => {
    const oldValue = left[key];
    const newValue = right[key];
    const numeric =
      typeof oldValue === 'number' && typeof newValue === 'number';
    const delta = numeric ? newValue - oldValue : null;
    return {
      key,
      label,
      before: oldValue,
      after: newValue,
      delta,
      changed: oldValue !== newValue,
    };
  });
};

const display = (value) => {
  if (value === null) return 'missing';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  return String(value);
};

const run = () => {
  const [beforePath, afterPath] = process.argv.slice(2);
  if (!beforePath || !afterPath) {
    console.error('usage: compare-summary.mjs <before.json> <after.json>');
    process.exit(2);
  }
  const rows = compareSummaries(
    JSON.parse(readFileSync(beforePath, 'utf8')),
    JSON.parse(readFileSync(afterPath, 'utf8'))
  );
  const width = Math.max(
    ...rows.map((row) => row.label.length),
    'metric'.length
  );
  console.log(
    `${'metric'.padEnd(width)}  ${'before'.padStart(12)}  ${'after'.padStart(12)}  delta`
  );
  for (const row of rows) {
    const delta = row.delta === null ? '' : String(row.delta);
    console.log(
      `${row.label.padEnd(width)}  ${display(row.before).padStart(12)}  ${display(row.after).padStart(12)}  ${delta}`
    );
  }
  const changed = rows.filter((row) => row.changed);
  console.log('');
  console.log(`SUMMARY_COMPARE_CHANGED=${changed.length}`);
  console.log(`SUMMARY_COMPARE_TOTAL=${rows.length}`);
  console.log(
    `SUMMARY_COMPARE_STATUS=${changed.length === 0 ? 'SAME' : 'DIFFERENT'}`
  );
};

if (process.argv[1] === fileURLToPath(import.meta.url)) run();
