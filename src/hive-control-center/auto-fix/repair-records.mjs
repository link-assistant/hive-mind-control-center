// Runs inside the hive-mind container (as the bot user) via auto-fix.mjs, which
// prepends `const PARAMS = {...};`. Keeps start-command's execution store true
// to what is running, so every task is finalized and cleaned up when it ends,
// even when the bot no longer watches it:
//   1. A 0-byte `executions.lock` older than 2 minutes is removed. A disk-full
//      error while the lock was created leaves it empty; start-command never
//      treats it as stale, so every later write fails (link-foundation/start#193).
//   2. A running task container whose record is not `executing` under that
//      container's name (a `$ --resume` that could not save its record) gets
//      the record a successful resume would have written, built with
//      start-command's own functions.
//   3. Every running task container without a completion watcher gets one
//      (start-command's own `docker logs -f` + wait + finalize watcher), so the
//      exit is recorded and the container cleaned up by its policy.
// With PARAMS.act false it only reports what it would do. Prints one AF_JSON line.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execSync, execFileSync } from 'node:child_process';

const sh = (command) => execSync(command, { shell: '/bin/bash', encoding: 'utf8' }).trim();
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8' }).trim();
const startCommand = sh("command -v '$'");
const libDir = path.join(path.dirname(fs.realpathSync(startCommand)), '..', 'lib');
const require = createRequire(path.join(libDir, 'x.js'));
const { ExecutionStore } = require('./execution-store.js');
const { createAttempt, patchAttempt } = require('./execution-attempt.js');
const { applyResumeToRecord } = require('./execution-resume.js');
const { getDockerContainerCleanupPolicy, startDetachedDockerCompletionWatcher } = require('./docker-cleanup.js');

const actions = [];
const store = new ExecutionStore();

const lockPath = store.lockFilePath;
if (fs.existsSync(lockPath)) {
  const stat = fs.statSync(lockPath);
  const ageS = Math.round((Date.now() - stat.mtimeMs) / 1000);
  if (stat.size === 0 && ageS > 120) {
    if (PARAMS.act) fs.unlinkSync(lockPath);
    actions.push((PARAMS.act ? 'removed' : 'would remove') + ' dead 0-byte start-command lock (' + ageS + 's old)');
  }
}

const listing = execFileSync(startCommand, ['--list', '--output-format', 'json'], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
const executions = (JSON.parse(listing.slice(listing.indexOf('{'))).executions || [])
  .filter((e) => e.options?.isolated === 'docker' && e.options?.isolationMode === 'detached');
const running = docker('ps', '--format', '{{.Names}}').split('\n').filter(Boolean);
const processes = execFileSync('ps', ['-eo', 'args'], { encoding: 'utf8' }).split('\n');
const hasWatcher = (name) => processes.some((p) => p.includes('docker logs -f') && p.includes(name));
// Tasks the bot itself watches (it reports and cleans those up by itself).
let tracked = {};
try {
  tracked = JSON.parse(fs.readFileSync(process.env.HOME + '/.hive-mind/state/sessions.json', 'utf8')).sessions || {};
} catch {}
const botTracked = new Set(Object.values(tracked).map((s) => s.executionUuid).filter(Boolean));
const resuming = (uuid) => processes.some((p) => p.includes('--resume ' + uuid));

const adopted = [];
for (const e of executions) {
  const options = e.options || {};
  const root = options.sessionNameHistory?.[0] || options.sessionName;
  // The newest family member (`<root>-resume-N...`) is the one doing the work.
  const current = running.filter((n) => n === root || n.startsWith(root + '-resume-')).sort((a, b) => b.length - a.length)[0];
  if (!current || resuming(e.uuid)) continue;
  let record = e;
  let repaired = false;
  if (e.status !== 'executing' || options.sessionName !== current) {
    const info = JSON.parse(docker('inspect', current))[0];
    const top = docker('top', current, '-eo', 'pid,args');
    const command = (top.split('\n').find((l) => /\bsh -c solve /.test(l)) || '').replace(/^\s*\d+\s+sh -c /, '') || e.command;
    const plan = {
      mode: 'docker-snapshot',
      backend: 'docker',
      attempt: Number((current.match(/-resume-(\d+)$/) || [])[1]) || 1,
      sessionName: options.sessionName,
      newSessionName: current,
      snapshotImage: info.Config.Image,
      command,
    };
    const startedAt = new Date(info.State.StartedAt).toISOString();
    repaired = true;
    actions.push((PARAMS.act ? 'repaired' : 'would repair') + ' record ' + e.uuid + ' (' + e.status + ' ' + options.sessionName + ') -> executing ' + current);
    if (PARAMS.act) {
      const fresh = store.get(e.uuid) || e;
      const attempt = createAttempt(fresh, plan);
      attempt.startedAt = startedAt;
      attempt.launchAcceptedAt = startedAt;
      record = applyResumeToRecord(fresh, plan, info.Id, attempt);
      store.save(record);
    }
  }
  if (!hasWatcher(current)) {
    actions.push((PARAMS.act ? 'attached' : 'would attach') + ' completion watcher to ' + current + ' (' + e.uuid + ')');
    if (PARAMS.act) {
      const since = record.attempt?.startedAt || record.startTime;
      const ok = startDetachedDockerCompletionWatcher(current, getDockerContainerCleanupPolicy(record.options), record.logPath || null, e.uuid, {
        since,
        attemptNumber: record.attempt?.number,
        recoverOnKill: false,
      });
      if (ok && record.attempt) patchAttempt(store, record, { watcherAttachedAt: new Date().toISOString() });
    }
  }
  adopted.push({ uuid: e.uuid, container: current, repaired, botTracked: botTracked.has(e.uuid) });
}
console.log('AF_JSON:' + JSON.stringify({ actions, adopted }));
