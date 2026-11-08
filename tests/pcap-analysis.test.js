import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'test-anywhere';

const pcapScript = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'src/hive-control-center/scripts/mtproxy/pcap.mjs'
);

const ipv4 = (text) => Buffer.from(text.split('.').map(Number));
const port = (value) => {
  const buffer = Buffer.alloc(2);
  buffer.writeUInt16BE(value);
  return buffer;
};

function packet({
  src,
  dst,
  sport,
  dport,
  seq,
  ackNum,
  flags,
  payload = Buffer.alloc(0),
}) {
  const options =
    flags === 0x02 ? Buffer.from([2, 4, 0x04, 0xb0]) : Buffer.alloc(0);
  const tcpLength = 20 + options.length;
  const totalLength = 20 + tcpLength + payload.length;
  const ip = Buffer.alloc(20);
  ip[0] = 0x45;
  ip.writeUInt16BE(totalLength, 2);
  ip[8] = 64;
  ip[9] = 6;
  ipv4(src).copy(ip, 12);
  ipv4(dst).copy(ip, 16);
  const tcp = Buffer.alloc(tcpLength);
  port(sport).copy(tcp, 0);
  port(dport).copy(tcp, 2);
  tcp.writeUInt32BE(seq, 4);
  tcp.writeUInt32BE(ackNum, 8);
  tcp[12] = ((tcpLength / 4) << 4) & 0xf0;
  tcp[13] = flags;
  options.copy(tcp, 20);
  const ethernet = Buffer.alloc(14);
  ethernet.writeUInt16BE(0x0800, 12);
  return Buffer.concat([ethernet, ip, tcp, payload]);
}

function pcap(packets) {
  const header = Buffer.alloc(24);
  header.writeUInt32LE(0xa1b2c3d4, 0);
  header.writeUInt16LE(2, 4);
  header.writeUInt16LE(4, 6);
  header.writeUInt32LE(65535, 16);
  header.writeUInt32LE(1, 20);
  const records = packets.map((item, index) => {
    const record = Buffer.alloc(16);
    record.writeUInt32LE(1 + index, 0);
    record.writeUInt32LE(0, 4);
    record.writeUInt32LE(item.length, 8);
    record.writeUInt32LE(item.length, 12);
    return Buffer.concat([record, item]);
  });
  return Buffer.concat([header, ...records]);
}

describe('pcap analysis', () => {
  it('separates wire bytes, retransmits, ACK gaps, and resets', () => {
    const source = pcap([
      packet({
        src: '10.0.0.2',
        dst: '203.0.113.1',
        sport: 5555,
        dport: 443,
        seq: 1000,
        ackNum: 0,
        flags: 0x02,
      }),
      packet({
        src: '203.0.113.1',
        dst: '10.0.0.2',
        sport: 443,
        dport: 5555,
        seq: 5000,
        ackNum: 1001,
        flags: 0x12,
      }),
      packet({
        src: '10.0.0.2',
        dst: '203.0.113.1',
        sport: 5555,
        dport: 443,
        seq: 1001,
        ackNum: 5001,
        flags: 0x18,
        payload: Buffer.from('hello'),
      }),
      packet({
        src: '203.0.113.1',
        dst: '10.0.0.2',
        sport: 443,
        dport: 5555,
        seq: 5001,
        ackNum: 1006,
        flags: 0x18,
        payload: Buffer.from('world!'),
      }),
      packet({
        src: '203.0.113.1',
        dst: '10.0.0.2',
        sport: 443,
        dport: 5555,
        seq: 5001,
        ackNum: 1006,
        flags: 0x18,
        payload: Buffer.from('world!'),
      }),
      packet({
        src: '203.0.113.1',
        dst: '10.0.0.2',
        sport: 443,
        dport: 5555,
        seq: 5007,
        ackNum: 1006,
        flags: 0x18,
        payload: Buffer.from('more'),
      }),
      packet({
        src: '10.0.0.2',
        dst: '203.0.113.1',
        sport: 5555,
        dport: 443,
        seq: 1006,
        ackNum: 5004,
        flags: 0x10,
      }),
      packet({
        src: '203.0.113.1',
        dst: '10.0.0.2',
        sport: 443,
        dport: 5555,
        seq: 5011,
        ackNum: 1006,
        flags: 0x14,
      }),
    ]);
    const result = spawnSync(process.execPath, [pcapScript, '--port', '443'], {
      input: source,
      encoding: 'utf8',
    });
    expect(result.status).toBe(0);
    const output = result.stdout;
    expect(output).toContain('CAPTURE_CLIENT_BYTES=5');
    expect(output).toContain('CAPTURE_PROXY_BYTES=16');
    expect(output).toContain('CAPTURE_CLIENT_CONNS=1');
    expect(output).toContain('CAPTURE_PROXY_CONNS=1');
    expect(output).toContain('CAPTURE_PROXY_RETRANSMITS=1');
    expect(output).toContain('CAPTURE_PROXY_RETRANSMIT_BYTES=6');
    expect(output).toContain('CAPTURE_PROXY_ACK_GAP_MAX=7');
    expect(output).toContain('CAPTURE_PROXY_ACK_GAP_FLOWS=1');
    expect(output).toContain('CAPTURE_PROXY_RST=1');
    expect(output).toContain('CAPTURE_MSS=1200');
    expect(output).toContain('VERDICT: proxy -> client loss observed');
  });
});
