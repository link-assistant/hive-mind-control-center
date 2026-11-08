// Repair start-command records for resumes whose store.save() failed because of
// a dead (0-byte) executions.lock. Uses start-command's own functions so the
// record looks exactly like a successful `$ --resume` and attaches the
// completion watcher that the failed resume never started.
// Runs inside the hive-mind container (as box, next to ~/.start-command).
// Usage: node repair-start-records.cjs <libDir> [--apply] <uuid>...
//   libDir: start-command's src/lib, e.g. "$(dirname "$(realpath "$(command -v '$')")")/../lib"
//   Without --apply it only prints what it would do.
// From this machine (dry run; add --apply after reviewing):
//   B=$(base64 < repair-start-records.cjs | tr -d '\n')
//   sshpass -p "$SERVER_PASS" ssh root@$SERVER_IP "docker exec hive-mind bash -lc 'echo $B | base64 -d > /tmp/repair-start-records.cjs;
//     L=\$(dirname \$(realpath \$(command -v \\\$)))/../lib; node /tmp/repair-start-records.cjs \$L <uuid>...'"
// Root cause it repairs: link-foundation/start#193 (0-byte lock left by ENOSPC).
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const [libDir, ...rest] = process.argv.slice(2);
const apply = rest.includes('--apply');
const uuids = rest.filter((a) => a !== '--apply');
const lib = (m) => require(path.join(libDir, m));
const { ExecutionStore } = lib('execution-store.js');
const { createAttempt, patchAttempt } = lib('execution-attempt.js');
const { applyResumeToRecord } = lib('execution-resume.js');
const { getDockerContainerCleanupPolicy, startDetachedDockerCompletionWatcher } = lib('docker-cleanup.js');

const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8' }).trim();
const store = new ExecutionStore();

// 1. A 0-byte lock can never be a live holder's lock for long: the holder
// writes its JSON right after creating the file. acquire() never removes it
// (readLockFile() -> null skips the stale check), so every write times out.
const lockPath = store.lockFilePath;
if (fs.existsSync(lockPath)) {
  const st = fs.statSync(lockPath);
  const ageS = Math.round((Date.now() - st.mtimeMs) / 1000);
  console.log(`lock ${lockPath}: ${st.size} bytes, ${ageS}s old`);
  if (st.size === 0 && ageS > 120) {
    if (apply) {
      fs.unlinkSync(lockPath);
      console.log('  removed dead 0-byte lock');
    } else console.log('  would remove dead 0-byte lock');
  } else if (st.size > 0) {
    console.log(`  live lock content: ${fs.readFileSync(lockPath, 'utf8')}`);
  }
}

const running = docker('ps', '--format', '{{.Names}}').split('\n').filter(Boolean);
const watchers = execFileSync('ps', ['-eo', 'args'], { encoding: 'utf8' });

for (const uuid of uuids) {
  const record = store.get(uuid);
  if (!record) {
    console.log(`${uuid}: no record`);
    continue;
  }
  const opts = record.options || {};
  const root = (opts.sessionNameHistory && opts.sessionNameHistory[0]) || opts.sessionName;
  const current = running.filter((n) => n === root || n.startsWith(`${root}-resume-`)).sort((a, b) => b.length - a.length)[0];
  console.log(`${uuid}: status=${record.status} exit=${record.exitCode} session=${opts.sessionName} -> running=${current || 'NONE'}`);
  if (!current) continue;
  if (record.status === 'executing' && opts.sessionName === current) {
    console.log('  already up to date');
    continue;
  }
  const info = JSON.parse(docker('inspect', current))[0];
  const top = docker('top', current, '-eo', 'pid,args');
  const cmdLine = (top.split('\n').find((l) => /\bsh -c solve /.test(l)) || '').replace(/^\s*\d+\s+sh -c /, '');
  const n = Number((current.match(/-resume-(\d+)$/) || [])[1]) || 1;
  const plan = {
    mode: 'docker-snapshot',
    backend: 'docker',
    attempt: n,
    sessionName: opts.sessionName,
    newSessionName: current,
    snapshotImage: info.Config.Image,
    command: cmdLine || record.command,
  };
  const startedAt = new Date(info.State.StartedAt).toISOString();
  const hasWatcher = watchers.split('\n').some((l) => l.includes('docker logs -f') && l.includes(current));
  console.log(`  plan: attempt ${n}, image ${plan.snapshotImage}, started ${startedAt}, watcher running: ${hasWatcher}`);
  console.log(`  command: ${plan.command.slice(0, 160)}`);
  if (!apply) continue;
  const attempt = createAttempt(record, plan);
  attempt.startedAt = startedAt;
  attempt.launchAcceptedAt = startedAt;
  const updated = applyResumeToRecord(record, plan, info.Id, attempt);
  store.save(updated);
  console.log(`  saved: status=${updated.status} session=${updated.options.sessionName}`);
  if (!hasWatcher) {
    const ok = startDetachedDockerCompletionWatcher(
      current,
      getDockerContainerCleanupPolicy(updated.options),
      updated.logPath || null,
      uuid,
      { since: startedAt, attemptNumber: attempt.number, recoverOnKill: false }
    );
    if (ok) patchAttempt(store, updated, { watcherAttachedAt: new Date().toISOString() });
    console.log(`  completion watcher started: ${ok}`);
  }
}
