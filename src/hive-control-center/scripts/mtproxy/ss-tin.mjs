#!/usr/bin/env node
import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
let path = '';
let port = '';
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === '--port') port = String(args[++i] ?? '');
  else if (args[i] === '--help' || args[i] === '-h') {
    console.log('usage: ss-tin.mjs [file] [--port 443]');
    process.exit(0);
  } else if (!path) path = args[i];
}

const text = path ? readFileSync(path, 'utf8') : readFileSync(0, 'utf8');
const lines = text.split(/\r?\n/);
let connections = 0;
let active = 0;
let noPayload = 0;
let stalled = 0;
let received = 0;
let sent = 0;

const number = (line, key) => {
  const match = line.match(new RegExp(`${key}:(\\d+)`));
  return match ? Number(match[1]) : 0;
};

let currentMatches = false;
for (const line of lines) {
  if (line.trim() && !/^\s/.test(line)) {
    const fields = line.split(/\s+/);
    const localIndex = /^\d+$/.test(fields[0]) ? 2 : 3;
    currentMatches = !port || new RegExp(`:${port}$`).test(fields[localIndex] ?? '');
    if (currentMatches) connections += 1;
    continue;
  }
  if (!currentMatches || !line.includes('segs_in:')) continue;
  const segsIn = number(line, 'segs_in');
  const lastReceived = number(line, 'lastrcv');
  const bytesReceived = number(line, 'bytes_received');
  const bytesSent = number(line, 'bytes_sent');
  received += bytesReceived;
  sent += bytesSent;
  if (bytesReceived > 0) active += 1;
  if (segsIn <= 2 && lastReceived > 20000) noPayload += 1;
  if (bytesReceived === 0 && lastReceived > 20000) stalled += 1;
}

console.log(
  `client_payload_connections=${connections} client_no_payload=${noPayload} ` +
    `client_active=${active} client_bytes_received=${received} ` +
    `client_bytes_sent=${sent} client_stalled_no_payload=${stalled}`,
);
