#!/usr/bin/env node
import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
let path = '';
let proxyPort = 443;
let clientFilter = '';
for (let i = 0; i < args.length; i += 1) {
  const arg = args[i];
  if (arg === '--port') proxyPort = Number(args[++i]);
  else if (arg === '--client') clientFilter = args[++i] ?? '';
  else if (arg === '--help' || arg === '-h') {
    console.log('usage: pcap.mjs [file] [--port 443] [--client IP]');
    process.exit(0);
  } else if (!path) path = arg;
}
if (!Number.isInteger(proxyPort) || proxyPort < 1 || proxyPort > 65535) {
  console.error('invalid --port');
  process.exit(2);
}

const raw = path ? readFileSync(path) : readFileSync(0);
if (raw.length < 24) {
  console.log('FAIL: pcap header is too short');
  process.exit(0);
}

const magicLe = raw.readUInt32LE(0);
let little = true;
if ([0xa1b2c3d4, 0xa1b23c4d].includes(magicLe)) little = true;
else if ([0xd4c3b2a1, 0x4d3cb2a1].includes(magicLe)) little = false;
else {
  console.log(`FAIL: unknown pcap magic 0x${magicLe.toString(16).padStart(8, '0')}`);
  process.exit(0);
}

const u16 = (offset) => (little ? raw.readUInt16LE(offset) : raw.readUInt16BE(offset));
const u32 = (offset) => (little ? raw.readUInt32LE(offset) : raw.readUInt32BE(offset));
const linktype = u32(20);
console.log(`linktype: ${linktype}`);

const ipv4ToString = (buffer, offset) => Array.from(buffer.subarray(offset, offset + 4)).join('.');

function parseIpv4(packet, offset) {
  if (packet.length < offset + 20) return null;
  if (packet[offset] >> 4 !== 4) return null;
  const ihl = (packet[offset] & 0x0f) * 4;
  if (packet.length < offset + ihl + 20) return null;
  if (packet[offset + 9] !== 6) return null;
  const src = ipv4ToString(packet, offset + 12);
  const dst = ipv4ToString(packet, offset + 16);
  const tcp = offset + ihl;
  const sport = packet.readUInt16BE(tcp);
  const dport = packet.readUInt16BE(tcp + 2);
  const dataOffset = (packet[tcp + 12] >> 4) * 4;
  const flags = packet[tcp + 13];
  const payload = packet.subarray(tcp + dataOffset);
  const options = packet.subarray(tcp + 20, tcp + dataOffset);
  return { src, dst, sport, dport, flags, payload, options };
}

function mssOf(options) {
  let i = 0;
  while (i < options.length) {
    const kind = options[i];
    if (kind === 0) break;
    if (kind === 1) {
      i += 1;
      continue;
    }
    if (i + 1 >= options.length) break;
    const length = options[i + 1];
    if (length < 2 || i + length > options.length) break;
    if (kind === 2 && length === 4) return options.readUInt16BE(i + 2);
    i += length;
  }
  return null;
}

function ipOffset(packet) {
  if (linktype === 1) {
    if (packet.length < 14) return null;
    const etherType = packet.readUInt16BE(12);
    if (etherType === 0x0800) return 14;
    if (etherType === 0x8100 && packet.length >= 18) return 18;
    return null;
  }
  if (linktype === 113) {
    if (packet.length < 16) return null;
    return packet.readUInt16BE(14) === 0x0800 ? 16 : null;
  }
  if (linktype === 276) {
    if (packet.length < 20) return null;
    return packet.readUInt16BE(0) === 0x0800 ? 20 : null;
  }
  if (linktype === 101) return 0;
  return null;
}

const connections = new Map();
const syns = [];
const firstData = [];
let synAcks = 0;
let offset = 24;

while (offset + 16 <= raw.length) {
  const included = u32(offset + 8);
  offset += 16;
  const packet = raw.subarray(offset, offset + included);
  offset += included;
  if (packet.length < included) break;

  const ip = ipOffset(packet);
  if (ip === null) continue;
  const parsed = parseIpv4(packet, ip);
  if (!parsed) continue;
  const { src, dst, sport, dport, flags, payload, options } = parsed;
  if (sport !== proxyPort && dport !== proxyPort) continue;
  if (clientFilter && src !== clientFilter && dst !== clientFilter) continue;

  const syn = Boolean(flags & 0x02);
  const ack = Boolean(flags & 0x10);
  if (syn && !ack) syns.push({ src, sport, dst, dport, mss: mssOf(options) });
  else if (syn && ack && sport === proxyPort) synAcks += 1;

  if (payload.length === 0) continue;
  const key = `${src}:${sport}->${dst}:${dport}`;
  let item = connections.get(key);
  if (!item) {
    item = { src, sport, dst, dport, packets: 0, bytes: 0, first: payload.subarray(0, 16) };
    connections.set(key, item);
  }
  item.packets += 1;
  item.bytes += payload.length;
  if (firstData.length < 3 && dport === proxyPort) {
    firstData.push({ src, sport, length: payload.length, head: payload.subarray(0, 16) });
  }
}

const hex = (buffer) => Buffer.from(buffer).toString('hex');
const clientSyns = syns.filter((syn) => syn.dport === proxyPort);
console.log('SYN MSS (client -> proxy):');
if (clientSyns.length === 0) console.log('  NONE');
for (const syn of clientSyns.slice(0, 10)) {
  console.log(`  ${syn.src}:${syn.sport} -> ${syn.dst}:${syn.dport} mss=${syn.mss}`);
}

const clientData = [...connections.values()].filter((item) => item.dport === proxyPort);
const proxyData = [...connections.values()].filter((item) => item.sport === proxyPort);
const clientBytes = clientData.reduce((sum, item) => sum + item.bytes, 0);
const proxyBytes = proxyData.reduce((sum, item) => sum + item.bytes, 0);

console.log('TCP data (client -> proxy):');
if (clientData.length === 0) console.log('  NONE');
for (const item of clientData.slice(0, 20)) {
  console.log(
    `  ${item.src}:${item.sport} -> ${item.dst}:${item.dport} packets=${item.packets} ` +
      `bytes=${item.bytes} first=${hex(item.first)}`,
  );
}

console.log('first client data packets:');
if (firstData.length === 0) console.log('  NONE');
for (const item of firstData) {
  console.log(`  ${item.src}:${item.sport} length=${item.length} first=${hex(item.head)}`);
}

console.log('TCP data (proxy -> client):');
if (proxyData.length === 0) console.log('  NONE');
for (const item of proxyData.slice(0, 20)) {
  console.log(
    `  ${item.src}:${item.sport} -> ${item.dst}:${item.dport} packets=${item.packets} ` +
      `bytes=${item.bytes} first=${hex(item.first)}`,
  );
}

console.log(`CAPTURE_CLIENT_BYTES=${clientBytes}`);
console.log(`CAPTURE_PROXY_BYTES=${proxyBytes}`);
console.log(`CAPTURE_CLIENT_CONNS=${clientData.length}`);
console.log(`CAPTURE_SYN=${clientSyns.length}`);
console.log(`CAPTURE_SYN_ACK=${synAcks}`);
if (clientSyns.length > 0) console.log(`CAPTURE_MSS=${clientSyns[0].mss}`);

const firstTls = clientData.find((item) => item.first[0] === 0x16 && item.first[1] === 0x03);
if (clientBytes === 0 && (clientSyns.length > 0 || synAcks > 0)) {
  console.log(
    'VERDICT: TCP handshakes were captured but no client payload; this is normal while idle. ' +
      'Restart Telegram or send a text/media to exercise the path.',
  );
} else if (clientBytes > 0 && proxyBytes === 0 && clientBytes < 64) {
  console.log(
    `VERDICT: only ${clientBytes} byte probe(s) captured; reconnect or restart Telegram to exercise a real MTProto handshake.`,
  );
} else if (clientBytes > 0 && proxyBytes === 0) {
  console.log(
    'VERDICT: client payload reached the proxy but the proxy sent no payload back ' +
      '(upstream/DC problem or proxy stall).',
  );
} else if (clientBytes > 0 && proxyBytes > 0) {
  console.log(
    `VERDICT: bidirectional payload observed (client->proxy=${clientBytes} bytes, ` +
      `proxy->client=${proxyBytes} bytes).`,
  );
} else if (firstTls) {
  console.log('VERDICT: TLS ClientHello detected in client payload.');
} else {
  console.log('VERDICT: no client payload detected in the capture.');
}
