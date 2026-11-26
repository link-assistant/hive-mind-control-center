import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import test from 'node:test';

const source = fs.readFileSync(new URL('./report.mjs', import.meta.url), 'utf8');
const start = source.indexOf('// --- report-logic:start ---');
const end = source.indexOf('// --- report-logic:end ---');
assert.ok(start >= 0 && end > start);
const logic = source.slice(start, end)
  .replace('// --- report-logic:start ---', '')
  .replace('// --- report-logic:end ---', '');
const context = vm.createContext({ crypto, fs, Buffer, console });
vm.runInContext(`${logic}\nglobalThis.logic = { readWindow, compareDocker, attemptWindow, overlaps, localFailureSignature, dockerLinesForAttempt, recoveryOutcome };`, context);
const { readWindow, compareDocker, attemptWindow, overlaps, localFailureSignature, dockerLinesForAttempt, recoveryOutcome } = context.logic;

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'report-logic-'));
test.after(() => fs.rmSync(scratch, { recursive: true, force: true }));

test('attempt 2 reads from its own logOffset, never the earlier attempt', () => {
  const first = 'first attempt terminal line\n';
  const second = 'second attempt terminal line\nExit Code: 1\n';
  const file = path.join(scratch, 'shared.log');
  fs.writeFileSync(file, first + second);
  const window = readWindow(file, Buffer.byteLength(first), null, 512 * 1024);
  assert.equal(window.ambiguous, false);
  assert.equal(window.clipped, false);
  assert.equal(window.text, second);
  assert.ok(!window.text.includes('first attempt'));
});

test('an unknown start offset is marked ambiguous', () => {
  const file = path.join(scratch, 'ambiguous.log');
  fs.writeFileSync(file, 'first attempt\nsecond attempt\nExit Code: 1\n');
  const window = readWindow(file, null, null, 512 * 1024);
  assert.equal(window.ambiguous, true);
  assert.match(window.text, /first attempt/);
});

test('a clipped attempt window is marked instead of compared', () => {
  const file = path.join(scratch, 'long.log');
  fs.writeFileSync(file, 'x'.repeat(4096));
  const window = readWindow(file, 0, null, 1024);
  assert.equal(window.clipped, true);
  assert.equal(window.bytes, 1024);
  const result = compareDocker(window.text, ['a different row'], window);
  assert.equal(result.status, 'inconclusive');
  assert.equal(result.missing.length, 0);
});

test('same ordered Docker stream matches even when a long record is split', () => {
  const ts = '2026-11-23T03:05:11.819268264Z ';
  const first = ts + '{"body":"'.padEnd(16 * 1024, 'a');
  const last = ts + 'rest"}\n';
  const err = '2026-11-23T03:05:11.820000000Z stderr-marker\n';
  const wrapper = first + err + last;
  const ordered = wrapper.split('\n').filter(Boolean);
  const separateBuffers = (first + last).trim() + '\n' + err.trim();
  const window = { ambiguous: false, clipped: false, bytes: wrapper.length };
  assert.equal(compareDocker(wrapper, ordered, window).status, 'matches');
  const bad = compareDocker(wrapper, separateBuffers.split('\n').filter(Boolean), window);
  assert.equal(bad.status, 'differs');
  assert.equal(bad.missing.length, 2);
  assert.ok(bad.missing.every((row) => row.length > 0 && /^[0-9a-f]{12}$/.test(row.sha256)));
});

test('Docker rows are limited to the attempt timestamps', () => {
  const rows = [
    '2026-11-23T03:00:00.000000000Z earlier',
    '2026-11-23T03:04:30.000000000Z inside',
    '2026-11-23T03:06:00.000000000Z later',
  ];
  const filtered = dockerLinesForAttempt({ dockerLogs: rows }, {
    startedAt: '2026-11-23T03:04:16.201Z',
    finishedAt: '2026-11-23T03:05:13.284Z',
  });
  assert.deepEqual(filtered, ['2026-11-23T03:04:30.000000000Z inside']);
});

test('terminal verdicts become distinct signatures', () => {
  assert.equal(localFailureSignature('❌ Repository setup failed - empty repository\n'), 'repository-empty');
  assert.equal(localFailureSignature('❌ Auto-restart limit reached after 5 iterations - the blocker was never resolved.\n'), 'auto-restart-limit');
  assert.equal(localFailureSignature('Error: Repository has uncommitted changes after clone: mvnw.cmd\n❌ Error occurred\n'), 'checkout-dirty');
  assert.equal(localFailureSignature('❌ No progress between sessions\n'), 'no-progress');
  assert.equal(localFailureSignature('❌ AI session failed (tool_failure)\n'), 'tool-failure');
  assert.equal(localFailureSignature('❌ The AI session failed and `--codex` stopped (tool_failure).\n   Incomplete response returned, reason: max_output_tokens\n❌ AI session failed (tool_failure)\n'), 'codex-max-output-tokens');
  assert.equal(localFailureSignature('❌ CODEX execution failed with This content was flagged for possible cybersecurity risk.\n'), 'tool-content-policy');
  assert.equal(localFailureSignature('some ordinary output\n'), null);
});

test('concurrency uses actual windows and excludes boundary touching', () => {
  const base = { startedAt: '2026-11-22T07:48:06.145Z', finishedAt: '2026-11-22T14:00:55.334Z' };
  const window = attemptWindow(base);
  const later = attemptWindow({ startedAt: '2026-11-22T16:49:18.987Z', finishedAt: '2026-11-22T17:00:00.000Z' });
  const alreadyRunning = attemptWindow({ startedAt: '2026-11-22T07:47:00.000Z', finishedAt: '2026-11-22T08:00:00.000Z' });
  const touching = attemptWindow({ startedAt: '2026-11-22T14:00:55.334Z', finishedAt: '2026-11-22T15:00:00.000Z' });
  assert.equal(overlaps(window, later), false);
  assert.equal(overlaps(window, alreadyRunning), true);
  assert.equal(overlaps(window, touching), false);
  assert.equal(attemptWindow({ startedAt: base.startedAt, status: 'executing' }).end > Date.parse(base.startedAt), true);
});

test('recovery finds a later execution, not only the next attempt of the same one', () => {
  const selected = { startedAt: '2026-11-25T23:20:37.832Z', finishedAt: '2026-11-26T02:28:22.729Z', status: 'executed' };
  const ownLater = [{ number: 2, status: 'executed', exitCode: 1, startedAt: '2026-11-26T02:29:51.384Z', finishedAt: '2026-11-26T06:36:07.997Z' }];
  const other = [{
    e: { uuid: '4f67937a-fa67-4b0a-90c4-c7a2029891a0' },
    a: { number: 1, status: 'executed', exitCode: 0, startedAt: '2026-11-26T02:34:58.549Z', finishedAt: '2026-11-26T07:33:43.977Z' },
    window: attemptWindow({ startedAt: '2026-11-26T02:34:58.549Z', finishedAt: '2026-11-26T07:33:43.977Z' }),
  }];
  assert.equal(recoveryOutcome(selected, ownLater, other), 'yes: `4f67937a-fa67-4b0a-90c4-c7a2029891a0` attempt 1 finished with exit 0 after this attempt');
});

test('a successful concurrent execution supersedes instead of being called no recovery', () => {
  const selected = { startedAt: '2026-11-26T02:29:51.384Z', finishedAt: '2026-11-26T06:36:07.997Z', status: 'executed' };
  const other = [{
    e: { uuid: '4f67937a-fa67-4b0a-90c4-c7a2029891a0' },
    a: { number: 1, status: 'executed', exitCode: 0, startedAt: '2026-11-26T02:34:58.549Z', finishedAt: '2026-11-26T07:33:43.977Z' },
    window: attemptWindow({ startedAt: '2026-11-26T02:34:58.549Z', finishedAt: '2026-11-26T07:33:43.977Z' }),
  }];
  assert.equal(recoveryOutcome(selected, [], other), 'yes: a concurrent execution finished with exit 0');
});

test('recovery keeps failed and running later attempts distinct', () => {
  const selected = { startedAt: '2026-11-25T23:20:37.832Z', finishedAt: '2026-11-26T02:28:22.729Z', status: 'executed' };
  const failed = { number: 2, status: 'executed', exitCode: 1, startedAt: '2026-11-26T02:29:51.384Z', finishedAt: '2026-11-26T06:36:07.997Z' };
  assert.equal(recoveryOutcome(selected, [failed], []), 'no: 1 later attempt(s) did not finish properly');
  assert.equal(recoveryOutcome(selected, [{ ...failed, status: 'executing', exitCode: null, finishedAt: null }], []), 'in progress: attempt 2 is running');
  assert.equal(recoveryOutcome(selected, [], []), 'no recovery attempt on record');
});
