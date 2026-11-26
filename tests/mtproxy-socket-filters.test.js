import { spawnSync } from 'node:child_process';
import { URL, fileURLToPath } from 'node:url';
import { describe, expect, it } from 'test-anywhere';
import { proxySocketRows } from '../src/hive-control-center/scripts/mtproxy/netstat.mjs';

const ssScript = fileURLToPath(
  new URL(
    '../src/hive-control-center/scripts/mtproxy/ss-tin.mjs',
    import.meta.url
  )
);
const socketSample = [
  '0 0 192.0.2.1:443 192.0.2.2:56604',
  '  segs_in:8 bytes_received:88 bytes_sent:44 lastrcv:100',
  'ESTAB 0 0 [2001:db8::1]:8443 [2001:db8::2]:56605',
  '  segs_in:2 lastrcv:25000',
].join('\n');

function summarize(port) {
  const runtimeArgs = process.versions.deno ? ['run', '--no-config'] : [];
  const result = spawnSync(
    process.execPath,
    [...runtimeArgs, ssScript, '--port', port],
    {
      input: socketSample,
      encoding: 'utf8',
      timeout: 5000,
    }
  );
  expect(result.status).toBe(0);
  return result.stdout;
}

describe('MTProxy socket filtering', () => {
  it('counts only the exact local port in both ss output formats', () => {
    expect(summarize('443')).toContain(
      'client_active=1 client_bytes_received=88'
    );
    expect(summarize('8443')).toContain(
      'client_payload_connections=1 client_no_payload=1'
    );
  });

  it('treats port input literally', () => {
    expect(summarize('443|8443')).toContain('client_payload_connections=0');
  });

  it('checks the foreign address and port on the same TCP endpoint', () => {
    const expected = 'tcp4 0 0 192.0.2.2.56000 192.0.2.1.443 ESTABLISHED';
    const sample = [
      'tcp4 0 0 192.0.2.2.443 192.0.2.1.8443 ESTABLISHED',
      'tcp4 0 0 192.0.2.2.56000 192.0.2.10.443 ESTABLISHED',
      'udp4 0 0 192.0.2.2.56000 192.0.2.1.443',
      expected,
      '',
    ].join('\r\n');
    expect(proxySocketRows(sample, '192.0.2.1', '443')).toEqual([expected]);
  });
});
