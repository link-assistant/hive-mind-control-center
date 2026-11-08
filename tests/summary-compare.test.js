import { describe, expect, it } from 'test-anywhere';
import {
  compareSummaries,
  flattenSummary,
} from '../src/hive-control-center/scripts/mtproxy/compare-summary.mjs';

describe('summary comparison', () => {
  it('flattens the fields used by diagnostics', () => {
    const flat = flattenSummary({
      client: { app: { noResponseNew: 2 }, capture: { recvRetransmits: 4 } },
      server: { capture: { proxyRetransmits: 9 } },
      result: { status: 'FAIL' },
    });
    expect(flat['client.app.noResponseNew']).toBe(2);
    expect(flat['client.capture.recvRetransmits']).toBe(4);
    expect(flat['server.capture.proxyRetransmits']).toBe(9);
    expect(flat['result.status']).toBe('FAIL');
    expect(flat['server.listening']).toBe(null);
  });

  it('reports numeric deltas and changed status values', () => {
    const before = {
      client: { app: { noResponseNew: 0 } },
      server: { capture: { proxyRetransmits: 0, proxyAckGapMax: 0 } },
      result: { status: 'PASS' },
    };
    const after = {
      client: { app: { noResponseNew: 3 } },
      server: { capture: { proxyRetransmits: 40, proxyAckGapMax: 2436 } },
      result: { status: 'FAIL' },
    };
    const rows = compareSummaries(before, after);
    const byKey = Object.fromEntries(rows.map((row) => [row.key, row]));
    expect(byKey['client.app.noResponseNew'].delta).toBe(3);
    expect(byKey['server.capture.proxyRetransmits'].delta).toBe(40);
    expect(byKey['server.capture.proxyAckGapMax'].delta).toBe(2436);
    expect(byKey['result.status'].changed).toBe(true);
    expect(byKey['result.status'].delta).toBe(null);
  });
});
