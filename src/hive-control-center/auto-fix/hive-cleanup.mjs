// Container module: actual hive-cleanup CLI, scoped to preserved stopped targets.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

const targets = PARAMS.manifest.targets;
const live = PARAMS.liveSelection === true;
if (live) {
  if (PARAMS.manifest?.selection?.mode !== 'live-all-failed') throw new Error('Live selection is invalid');
} else if (!PARAMS.backupVerified || PARAMS.manifest.preservationVerified !== true) {
  throw new Error('Host backup verification must succeed first');
}
const inspect = (name) => {
  const r = spawnSync('docker', ['inspect', name], { encoding: 'utf8' });
  if (r.status !== 0) {
    if (/No such (object|container)/i.test(r.stderr)) return null;
    throw new Error('Could not inspect ' + name);
  }
  return JSON.parse(r.stdout)[0];
};
const runningIds = execFileSync('docker', ['ps', '-q'], { encoding: 'utf8' }).trim().split(/\s+/).filter(Boolean);
const before = runningIds.length ? JSON.parse(execFileSync('docker', ['inspect', ...runningIds], { encoding: 'utf8' })) : [];
for (const t of targets) {
  const c = inspect(t.id);
  if (!c || c.Name !== '/' + t.name || c.State.Running || c.State.Status !== 'exited' || c.State.FinishedAt !== t.finishedAt) throw new Error('Stopped target changed: ' + t.name);
}
const find = (name) => execFileSync('sh', ['-c', 'command -v ' + name], { encoding: 'utf8' }).trim();
const realDocker = find('docker');
const cleanup = find('hive-cleanup');
if (!path.isAbsolute(realDocker) || !path.isAbsolute(cleanup)) throw new Error('Cleanup executables must resolve to absolute paths');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'af-hive-cleanup-'));
fs.chmodSync(work, 0o700);
const bin = path.join(work, 'bin');
const empty = path.join(work, 'empty');
fs.mkdirSync(bin, { mode: 0o700 });
fs.mkdirSync(empty, { mode: 0o700 });
const targetFile = path.join(work, 'targets.json');
fs.writeFileSync(targetFile, JSON.stringify(targets), { mode: 0o600 });
fs.writeFileSync(path.join(bin, 'docker'), '#!/usr/bin/env python3\n' + PARAMS.guardSource, { mode: 0o700 });
const environment = { ...process.env, PATH: bin + ':' + process.env.PATH, TMPDIR: empty, AF_REAL_DOCKER: realDocker, AF_CLEANUP_TARGETS: targetFile };
let result;
try {
  const probe = spawnSync(path.join(bin, 'docker'), ['ps', '-a', '--format', '{{json .}}'], { encoding: 'utf8', env: environment, timeout: 30000 });
  if (probe.status !== 0) throw new Error('Docker cleanup adapter failed: ' + (probe.stderr || probe.error?.message || probe.status));
  const listed = probe.stdout.split('\n').filter(Boolean).map((line) => JSON.parse(line));
  if (targets.some((t) => !listed.some((c) => c.Names === t.name))) throw new Error('Docker cleanup adapter omitted selected containers');
  const args = [cleanup, '--docker-isolation=all', '--no-sessions', '--no-resolve-branches', '--no-agent-snapshots', '--no-keep-active-tasks-folders', PARAMS.dry ? '--dry-run' : '--force'];
  result = spawnSync(process.execPath, args, {
    encoding: 'utf8', timeout: 15 * 60000, maxBuffer: 4 * 1024 * 1024,
    cwd: work,
    env: environment,
  });
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}
const states = targets.map((t) => ({ name: t.name, id: t.id, remaining: inspect(t.id)?.State.Status || null }));
const protectedStates = before.map((c) => {
  const after = inspect(c.Id);
  return { name: c.Name.slice(1), id: c.Id, beforePid: c.State.Pid, afterPid: after?.State.Pid ?? null, status: after?.State.Status ?? 'missing', sameStartedAt: c.State.StartedAt === after?.State.StartedAt };
});
if (!live && !PARAMS.dry && states.every((s) => !s.remaining)) {
  const stateFile = path.join(os.homedir(), '.hive-mind/state/auto-fix-reports.json');
  const state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : { reported: {} };
  state.reported ||= {};
  for (const t of targets) state.reported[PARAMS.reportRepo + ' ' + t.execution + '#1'] = {
    url: t.reportUrl, failureComment: t.failureComment, found: true, at: new Date().toISOString(),
    cleanedAt: new Date().toISOString(), preservation: PARAMS.manifest.backupDirectory,
    cleanup: 'hive-cleanup via auto-fix',
  };
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(stateFile + '.tmp', JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(stateFile + '.tmp', stateFile);
}
const protectedUnchanged = protectedStates.every((s) => s.status !== 'missing' && s.sameStartedAt && (s.status !== 'running' || s.beforePid === s.afterPid) && (s.name !== 'hive-mind' || s.status === 'running'));
const plannedCount = Number(/docker remove (\d+)/.exec(result.stdout || '')?.[1] ?? -1);
const success = result.status === 0 && plannedCount === targets.length && protectedUnchanged && (PARAMS.dry || states.every((s) => !s.remaining));
console.log('AF_JSON:' + JSON.stringify({ success, live, dry: PARAMS.dry, exit: result.status, plannedCount, output: result.stdout || '', error: result.stderr || result.error?.message || null, states, protected: protectedStates }));
