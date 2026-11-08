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
  console.log(
    `FAIL: unknown pcap magic 0x${magicLe.toString(16).padStart(8, '0')}`
  );
  process.exit(0);
}

const u32 = (offset) =>
  little ? raw.readUInt32LE(offset) : raw.readUInt32BE(offset);
const linktype = u32(20);
console.log(`linktype: ${linktype}`);

const ipv4ToString = (buffer, offset) =>
  Array.from(buffer.subarray(offset, offset + 4)).join('.');

function parseIpv4(packet, offset) {
  if (packet.length < offset + 20) return null;
  if (packet[offset] >> 4 !== 4) return null;
  const ihl = (packet[offset] & 0x0f) * 4;
  if (ihl < 20 || packet.length < offset + ihl + 20) return null;
  if (packet[offset + 9] !== 6) return null;
  const src = ipv4ToString(packet, offset + 12);
  const dst = ipv4ToString(packet, offset + 16);
  const tcp = offset + ihl;
  const dataOffset = (packet[tcp + 12] >> 4) * 4;
  if (dataOffset < 20 || packet.length < tcp + dataOffset) return null;
  return {
    src,
    dst,
    sport: packet.readUInt16BE(tcp),
    dport: packet.readUInt16BE(tcp + 2),
    seq: packet.readUInt32BE(tcp + 4),
    ackNum: packet.readUInt32BE(tcp + 8),
    flags: packet[tcp + 13],
    payload: packet.subarray(tcp + dataOffset),
    options: packet.subarray(tcp + 20, tcp + dataOffset),
  };
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

const newDirection = () => ({
  packets: 0,
  payloadBytes: 0,
  ranges: [],
  maxSeqEnd: 0,
  maxAck: 0,
  ackSeen: false,
  previousAck: null,
  duplicateAcks: 0,
  retransmitSegments: 0,
  retransmitBytes: 0,
  resets: 0,
  first: null,
});

const newFlow = (client, proxy) => ({
  client,
  proxy,
  clientToProxy: newDirection(),
  proxyToClient: newDirection(),
});

const lowerBound = (ranges, value) => {
  let low = 0;
  let high = ranges.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (ranges[mid][1] <= value) low = mid + 1;
    else high = mid;
  }
  return low;
};

const addRange = (direction, start, end) => {
  if (end <= start) return;
  let index = lowerBound(direction.ranges, start);
  if (index > 0 && direction.ranges[index - 1][1] > start) index -= 1;
  let mergedStart = start;
  let mergedEnd = end;
  let overlap = 0;
  let cursor = index;
  while (
    cursor < direction.ranges.length &&
    direction.ranges[cursor][0] < end
  ) {
    const [rangeStart, rangeEnd] = direction.ranges[cursor];
    overlap += Math.max(
      0,
      Math.min(end, rangeEnd) - Math.max(start, rangeStart)
    );
    mergedStart = Math.min(mergedStart, rangeStart);
    mergedEnd = Math.max(mergedEnd, rangeEnd);
    cursor += 1;
  }
  if (overlap > 0) {
    direction.retransmitSegments += 1;
    direction.retransmitBytes += overlap;
  }
  direction.ranges.splice(index, cursor - index, [mergedStart, mergedEnd]);
  direction.maxSeqEnd = Math.max(direction.maxSeqEnd, end);
};

const flows = new Map();
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
  const { src, dst, sport, dport, seq, ackNum, flags, payload, options } =
    parsed;
  if (sport !== proxyPort && dport !== proxyPort) continue;
  if (clientFilter && src !== clientFilter && dst !== clientFilter) continue;

  const syn = Boolean(flags & 0x02);
  const ack = Boolean(flags & 0x10);
  const reset = Boolean(flags & 0x04);
  if (syn && !ack) syns.push({ src, sport, dst, dport, mss: mssOf(options) });
  else if (syn && ack && sport === proxyPort) synAcks += 1;

  const clientIsSource = dport === proxyPort;
  if (clientIsSource === (sport === proxyPort)) continue;
  const client = clientIsSource
    ? { ip: src, port: sport }
    : { ip: dst, port: dport };
  const proxy = { ip: clientIsSource ? dst : src, port: proxyPort };
  const key = `${client.ip}:${client.port}|${proxy.ip}:${proxy.port}`;
  let flow = flows.get(key);
  if (!flow) {
    flow = newFlow(client, proxy);
    flows.set(key, flow);
  }
  const direction = clientIsSource ? flow.clientToProxy : flow.proxyToClient;
  if (direction.first === null && payload.length > 0) {
    direction.first = payload.subarray(0, 16);
  }
  if (payload.length > 0) {
    const start = seq + (syn ? 1 : 0) + (flags & 0x01 ? 1 : 0);
    addRange(direction, start, start + payload.length);
    direction.payloadBytes += payload.length;
    direction.packets += 1;
    if (firstData.length < 3 && clientIsSource) {
      firstData.push({
        src,
        sport,
        length: payload.length,
        head: payload.subarray(0, 16),
      });
    }
  }
  if (ack) {
    if (
      direction.ackSeen &&
      direction.previousAck === ackNum &&
      payload.length === 0
    ) {
      direction.duplicateAcks += 1;
    }
    direction.maxAck = Math.max(direction.maxAck, ackNum);
    direction.ackSeen = true;
    direction.previousAck = ackNum;
  }
  if (reset) direction.resets += 1;
}

const flowList = [...flows.values()];
const connectionOf = (flow, direction) => ({
  src: direction === flow.clientToProxy ? flow.client.ip : flow.proxy.ip,
  sport: direction === flow.clientToProxy ? flow.client.port : flow.proxy.port,
  dst: direction === flow.clientToProxy ? flow.proxy.ip : flow.client.ip,
  dport: direction === flow.clientToProxy ? flow.proxy.port : flow.client.port,
  packets: direction.packets,
  bytes: direction.payloadBytes,
  first: direction.first || Buffer.alloc(0),
  retransmits: direction.retransmitSegments,
  retransmitBytes: direction.retransmitBytes,
  resets: direction.resets,
});

const clientData = flowList
  .filter((flow) => flow.clientToProxy.payloadBytes > 0)
  .map((flow) => connectionOf(flow, flow.clientToProxy));
const proxyData = flowList
  .filter((flow) => flow.proxyToClient.payloadBytes > 0)
  .map((flow) => connectionOf(flow, flow.proxyToClient));
const clientBytes = clientData.reduce((sum, item) => sum + item.bytes, 0);
const proxyBytes = proxyData.reduce((sum, item) => sum + item.bytes, 0);
const clientRetransmits = flowList.reduce(
  (sum, flow) => sum + flow.clientToProxy.retransmitSegments,
  0
);
const clientRetransmitBytes = flowList.reduce(
  (sum, flow) => sum + flow.clientToProxy.retransmitBytes,
  0
);
const proxyRetransmits = flowList.reduce(
  (sum, flow) => sum + flow.proxyToClient.retransmitSegments,
  0
);
const proxyRetransmitBytes = flowList.reduce(
  (sum, flow) => sum + flow.proxyToClient.retransmitBytes,
  0
);
const clientResets = flowList.reduce(
  (sum, flow) => sum + flow.clientToProxy.resets,
  0
);
const proxyResets = flowList.reduce(
  (sum, flow) => sum + flow.proxyToClient.resets,
  0
);
const clientDuplicateAcks = flowList.reduce(
  (sum, flow) => sum + flow.clientToProxy.duplicateAcks,
  0
);
const proxyDuplicateAcks = flowList.reduce(
  (sum, flow) => sum + flow.proxyToClient.duplicateAcks,
  0
);

const proxyGaps = flowList
  .filter(
    (flow) => flow.proxyToClient.maxSeqEnd > 0 && flow.clientToProxy.ackSeen
  )
  .map((flow) => ({
    ...connectionOf(flow, flow.proxyToClient),
    gap: Math.max(0, flow.proxyToClient.maxSeqEnd - flow.clientToProxy.maxAck),
    ack: flow.clientToProxy.maxAck,
    seqEnd: flow.proxyToClient.maxSeqEnd,
  }));
const clientGaps = flowList
  .filter(
    (flow) => flow.clientToProxy.maxSeqEnd > 0 && flow.proxyToClient.ackSeen
  )
  .map((flow) => ({
    ...connectionOf(flow, flow.clientToProxy),
    gap: Math.max(0, flow.clientToProxy.maxSeqEnd - flow.proxyToClient.maxAck),
    ack: flow.proxyToClient.maxAck,
    seqEnd: flow.clientToProxy.maxSeqEnd,
  }));
const proxyGapMax = proxyGaps.reduce((max, item) => Math.max(max, item.gap), 0);
const proxyGapSum = proxyGaps.reduce((sum, item) => sum + item.gap, 0);
const clientGapMax = clientGaps.reduce(
  (max, item) => Math.max(max, item.gap),
  0
);
const clientGapSum = clientGaps.reduce((sum, item) => sum + item.gap, 0);

const hex = (buffer) => Buffer.from(buffer).toString('hex');
const clientSyns = syns.filter((syn) => syn.dport === proxyPort);
console.log('SYN MSS (client -> proxy):');
if (clientSyns.length === 0) console.log('  NONE');
for (const syn of clientSyns.slice(0, 10)) {
  console.log(
    `  ${syn.src}:${syn.sport} -> ${syn.dst}:${syn.dport} mss=${syn.mss}`
  );
}

console.log('TCP data (client -> proxy):');
if (clientData.length === 0) console.log('  NONE');
for (const item of clientData.slice(0, 20)) {
  console.log(
    `  ${item.src}:${item.sport} -> ${item.dst}:${item.dport} packets=${item.packets} ` +
      `bytes=${item.bytes} retransmits=${item.retransmits} first=${hex(item.first)}`
  );
}

console.log('first client data packets:');
if (firstData.length === 0) console.log('  NONE');
for (const item of firstData) {
  console.log(
    `  ${item.src}:${item.sport} length=${item.length} first=${hex(item.head)}`
  );
}

console.log('TCP data (proxy -> client):');
if (proxyData.length === 0) console.log('  NONE');
for (const item of proxyData.slice(0, 20)) {
  console.log(
    `  ${item.src}:${item.sport} -> ${item.dst}:${item.dport} packets=${item.packets} ` +
      `bytes=${item.bytes} retransmits=${item.retransmits} first=${hex(item.first)}`
  );
}

console.log('proxy -> client ACK gaps (seq end minus client ACK):');
if (proxyGaps.length === 0) console.log('  NONE');
for (const item of proxyGaps.sort((a, b) => b.gap - a.gap).slice(0, 10)) {
  console.log(
    `  ${item.src}:${item.sport} -> ${item.dst}:${item.dport} seq_end=${item.seqEnd} ` +
      `client_ack=${item.ack} gap=${item.gap} retransmits=${item.retransmits}`
  );
}

console.log(`CAPTURE_CLIENT_BYTES=${clientBytes}`);
console.log(`CAPTURE_PROXY_BYTES=${proxyBytes}`);
console.log(`CAPTURE_CLIENT_CONNS=${clientData.length}`);
console.log(`CAPTURE_PROXY_CONNS=${proxyData.length}`);
console.log(`CAPTURE_SYN=${clientSyns.length}`);
console.log(`CAPTURE_SYN_ACK=${synAcks}`);
if (clientSyns.length > 0) console.log(`CAPTURE_MSS=${clientSyns[0].mss}`);
console.log(`CAPTURE_CLIENT_RETRANSMITS=${clientRetransmits}`);
console.log(`CAPTURE_CLIENT_RETRANSMIT_BYTES=${clientRetransmitBytes}`);
console.log(`CAPTURE_PROXY_RETRANSMITS=${proxyRetransmits}`);
console.log(`CAPTURE_PROXY_RETRANSMIT_BYTES=${proxyRetransmitBytes}`);
console.log(`CAPTURE_CLIENT_DUP_ACKS=${clientDuplicateAcks}`);
console.log(`CAPTURE_PROXY_DUP_ACKS=${proxyDuplicateAcks}`);
console.log(`CAPTURE_CLIENT_RST=${clientResets}`);
console.log(`CAPTURE_PROXY_RST=${proxyResets}`);
console.log(`CAPTURE_PROXY_ACK_GAP_MAX=${proxyGapMax}`);
console.log(`CAPTURE_PROXY_ACK_GAP_SUM=${proxyGapSum}`);
console.log(
  `CAPTURE_PROXY_ACK_GAP_FLOWS=${proxyGaps.filter((item) => item.gap > 0).length}`
);
console.log(`CAPTURE_CLIENT_ACK_GAP_MAX=${clientGapMax}`);
console.log(`CAPTURE_CLIENT_ACK_GAP_SUM=${clientGapSum}`);

const firstTls = clientData.find(
  (item) => item.first[0] === 0x16 && item.first[1] === 0x03
);
if (proxyRetransmits > 0 || proxyGapMax > 0) {
  console.log(
    `VERDICT: proxy -> client loss observed (retransmits=${proxyRetransmits}, ` +
      `ack_gap_max=${proxyGapMax}, gap_flows=${proxyGaps.filter((item) => item.gap > 0).length}).`
  );
} else if (clientBytes === 0 && (clientSyns.length > 0 || synAcks > 0)) {
  console.log(
    'VERDICT: TCP handshakes were captured but no client payload; this is normal while idle. ' +
      'Restart Telegram or send a text/media to exercise the path.'
  );
} else if (clientBytes > 0 && proxyBytes === 0 && clientBytes < 64) {
  console.log(
    `VERDICT: only ${clientBytes} byte probe(s) captured; reconnect or restart Telegram to exercise a real MTProto handshake.`
  );
} else if (clientBytes > 0 && proxyBytes === 0) {
  console.log(
    'VERDICT: client payload reached the proxy but the proxy sent no payload back ' +
      '(upstream/DC problem or proxy stall).'
  );
} else if (clientBytes > 0 && proxyBytes > 0) {
  console.log(
    `VERDICT: bidirectional payload observed without downstream retransmits ` +
      `(client->proxy=${clientBytes} bytes, proxy->client=${proxyBytes} bytes).`
  );
} else if (firstTls) {
  console.log('VERDICT: TLS ClientHello detected in client payload.');
} else {
  console.log('VERDICT: no client payload detected in the capture.');
}
