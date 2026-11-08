// Runs inside the hive-mind container (as the bot user) via auto-fix.mjs, which
// prepends `const PARAMS = {...};`. Classifies every recent start-command
// docker execution. With PARAMS.act it resumes the killed ones with
// hive-mind's own resume command (always with the `solve` program, never a
// Telegram alias); with PARAMS.cleanup it removes the containers and snapshot
// images of executions that finished with exit 0. Prints one AF_JSON line.
import fs from 'node:fs';
import path from 'node:path';
import { execSync, execFileSync, spawn } from 'node:child_process';
const sh = (command) => execSync(command, { shell: '/bin/bash', encoding: 'utf8' }).trim();
const startCommand = sh("command -v '$'");
const listing = execFileSync(startCommand, ['--list', '--output-format', 'json'], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
const executions = JSON.parse(listing.slice(listing.indexOf('{'))).executions || [];
// Only the fields used: `{{json .}}` also asks dockerd for every container's
// size, which walks each writable layer (slow, memory-hungry, and it fails
// while a task deletes files).
const containers = execFileSync('docker', ['ps', '-a', '--format', '{"Names":{{json .Names}},"State":{{json .State}},"Status":{{json .Status}}}'], { encoding: 'utf8' })
  .trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
const processes = execFileSync('ps', ['-eo', 'args'], { encoding: 'utf8' }).split('\n');
// Images '$ --resume' committed: start-command-resume/<session name>:<n>.
const snapshotImages = execFileSync('docker', ['image', 'ls', '--filter', 'reference=start-command-resume/*', '--format', '{"Repository":{{json .Repository}},"Tag":{{json .Tag}},"Size":{{json .Size}}}'], { encoding: 'utf8' })
  .trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
let tracked = {};
try {
  tracked = JSON.parse(fs.readFileSync(process.env.HOME + '/.hive-mind/state/sessions.json', 'utf8')).sessions || {};
} catch {}
const trackedUuids = new Set(Object.values(tracked).map((s) => s.executionUuid).filter(Boolean));

let dir = path.dirname(fs.realpathSync(sh('command -v hive-telegram-bot')));
while (dir !== '/' && !(fs.existsSync(dir + '/package.json') && JSON.parse(fs.readFileSync(dir + '/package.json', 'utf8')).name === '@link-assistant/hive-mind')) dir = path.dirname(dir);
const { readLastSessionIdFromLog, buildResumeCommand } = await import(dir + '/src/session-resume.lib.mjs');

// Shell words, enough for the commands hive-mind and start-command store.
const words = (text) => {
  const out = [];
  let current = null;
  let quote = null;
  for (const ch of text) {
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
      current = current ?? '';
    } else if (/\s/.test(ch)) {
      if (current !== null) out.push(current);
      current = null;
    } else {
      current = (current ?? '') + ch;
    }
  }
  if (current !== null) out.push(current);
  return out;
};
// The original launch is `...; exec 'solve' 'url' ...`; a bot resume is
// `/codex url ...` or `solve url ...`.
const solveArgs = (command) => {
  const match = /\bexec\s+'?solve'?\s+([\s\S]*)$/.exec(command) || /^\s*(?:\/[\w-]+|solve)\s+([\s\S]*)$/.exec(command);
  return match ? words(match[1]) : null;
};
const quote = (arg) => /^[\w@%+=:,.\/-]+$/.test(arg) ? arg : "'" + arg.replace(/'/g, "'\\''") + "'";

// Every container of an execution: the original and each snapshot-derived
// `<original>-resume-N...`. The record alone is not enough: when
// `$ --resume` cannot save it (store lock timeout), the new container runs
// while the record still names the previous one.
const family = (e) => {
  const root = e.options?.sessionNameHistory?.[0] || e.options?.sessionName;
  return containers.filter((c) => c.Names === root || c.Names.startsWith(root + '-resume-'));
};
// A task (URL) already running or being resumed in another execution, such
// as the bot's fresh fallback run, must not be resumed a second time.
const busyUrls = new Set();
const resumingUuid = (e) => processes.some((p) => p.includes('--resume ' + e.uuid) || p.startsWith('docker commit ' + (e.options?.sessionName || '') + ' '));
for (const e of executions) {
  const url = solveArgs(e.command || '')?.[0];
  const running = family(e).some((c) => c.State === 'running');
  if (url && (running || resumingUuid(e))) busyUrls.add(url);
}
// A killed execution is no longer the interrupted work once a newer execution
// of the same task finished properly (e.g. the user re-ran it).
// A user's /stop also ends with exit 137; resuming it would undo the stop.
// The bot logs `session_stop_requested` seconds before the container ends.
let stopEvents = null;
const stoppedByUser = (e) => {
  const end = Date.parse(e.endTime || '') || 0;
  if (!end) return false;
  if (!stopEvents) {
    try {
      stopEvents = execFileSync('grep', ['-F', 'EVENT session_stop_requested', process.env.HOME + '/hive-telegram-bot.log'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
        .split('\n').map((l) => ({ at: Date.parse(l.slice(0, 24)) || 0, name: (/"sessionName":"([^"]+)"/.exec(l) || [])[1] })).filter((s) => s.at && s.name);
    } catch {
      stopEvents = []; // grep exits 1 when no task was ever stopped
    }
  }
  return stopEvents.some((s) => s.name === e.options?.sessionName && s.at <= end + 60000 && s.at >= end - 10 * 60000);
};
const startedMs = (e) => Date.parse(e.startTime || '') || 0;
const finishedOkAfter = (e, url) => executions.some((other) => other !== e && other.exitCode === 0 && startedMs(other) > startedMs(e) && solveArgs(other.command || '')?.[0] === url);

// One acting run at a time: a second run (another terminal or machine) only
// reports, so two runs never resume or remove the same thing. mkdir is atomic;
// a lock left by a crashed run expires after 15 minutes.
const LOCK = '/tmp/auto-fix/act.lock';
let acting = PARAMS.act || PARAMS.cleanup;
let lockNote = null;
if (acting) {
  fs.mkdirSync('/tmp/auto-fix', { recursive: true });
  try {
    fs.mkdirSync(LOCK);
  } catch {
    const ageMs = Date.now() - fs.statSync(LOCK).mtimeMs;
    if (ageMs > 15 * 60000) {
      fs.rmSync(LOCK, { recursive: true, force: true });
      fs.mkdirSync(LOCK);
    } else {
      acting = false;
      lockNote = 'another auto-fix run is acting (lock ' + Math.round(ageMs / 1000) + 's old); this run only reports';
    }
  }
}

const results = [];
const cleaned = [];
try {
  for (const e of executions) {
    const options = e.options || {};
    if (options.isolated !== 'docker' || options.isolationMode !== 'detached') continue;
    const name = options.sessionName;
    const relatives = family(e);
    const container = relatives.find((c) => c.State === 'running') || relatives.find((c) => c.Names === name);
    const ended = Date.parse(e.endTime || '') || 0;
    const args = solveArgs(e.command || '');
    const resuming = resumingUuid(e);

    // Cleanup runs over every execution, not only the --since-hours window:
    // an execution that finished with exit 0 needs none of its containers or
    // snapshot images any more. Failed ones stay for investigation.
    if (acting && PARAMS.cleanup && e.status === 'executed' && e.exitCode === 0 && !resuming && !relatives.some((c) => c.State === 'running')) {
      for (const stopped of relatives.filter((c) => c.State === 'exited' || c.State === 'created' || c.State === 'dead')) {
        try {
          execFileSync('docker', ['rm', stopped.Names], { encoding: 'utf8' });
          cleaned.push('container ' + stopped.Names + ' (' + (args?.[0] || e.uuid) + ' finished)');
        } catch (error) {
          cleaned.push('could not remove container ' + stopped.Names + ': ' + error.message.split('\n')[0]);
        }
      }
      const members = [...(options.sessionNameHistory || []), name].filter(Boolean);
      for (const image of snapshotImages.filter((i) => members.some((m) => i.Repository === 'start-command-resume/' + m))) {
        const ref = image.Repository + ':' + image.Tag;
        try {
          // No -f: docker refuses to remove an image a container still uses.
          execFileSync('docker', ['rmi', ref], { encoding: 'utf8' });
          cleaned.push('image ' + ref + ' (' + image.Size + ')');
        } catch (error) {
          cleaned.push('kept image ' + ref + ': ' + error.message.split('\n')[0]);
        }
      }
    }

    let state;
    if (container?.State === 'running') state = 'running';
    else if (resuming) state = 'resuming';
    // A stopped container still on disk is listed however old it is.
    else if (ended < PARAMS.sinceMs && !(container && container.State !== 'running')) continue;
    else if (e.exitCode === 0) state = 'completed';
    else if (args && (e.exitCode === 137 || (e.exitCode === 127 && /^\s*\//.test(e.command)))) state = 'needs-resume';
    else state = 'exited-' + e.exitCode;
    if (state === 'needs-resume' && e.exitCode === 137 && stoppedByUser(e)) state = 'stopped-by-user';
    if (state === 'needs-resume' && e.exitCode === 137 && trackedUuids.has(e.uuid) && Date.now() - PARAMS.botStartMs < PARAMS.graceMs) {
      state = 'bot-recovering';
    }
    if ((state === 'needs-resume' || state === 'bot-recovering') && busyUrls.has(args[0])) state = 'running-elsewhere';
    if (state === 'needs-resume' && finishedOkAfter(e, args[0])) state = 'superseded';
    if (state === 'needs-resume' && (Number(options.resumeCount) || 0) >= PARAMS.maxResumes) state = 'resume-limit';

    let action = null;
    if (acting && PARAMS.act && state === 'needs-resume') {
      // 137: the original container, whose whole writable layer gets committed.
      // 127: a failed resume container on top of an existing snapshot (small).
      const fullSnapshot = e.exitCode === 137;
      if (fullSnapshot && !(PARAMS.allowSnapshotNames || []).includes(name)) {
        action = 'deferred: ' + (PARAMS.deferReasons?.[name] || 'waiting for free disk / the running snapshot');
      } else {
        const lastSessionId = readLastSessionIdFromLog(e.logPath);
        const built = buildResumeCommand({ sessionInfo: { command: 'solve', url: args[0], args }, lastSessionId, binary: 'solve' });
        const command = built
          ? built.display
          : ['solve', ...args.filter((a, i, all) => a !== '--resume' && all[i - 1] !== '--resume')].map(quote).join(' ');
        const out = fs.openSync('/tmp/auto-fix/' + e.uuid + '.log', 'a');
        const child = spawn(startCommand, ['--resume', e.uuid, '--output-format', 'json', '--', command], { detached: true, stdio: ['ignore', out, out] });
        child.unref();
        action = 'resumed: ' + command;
        state = 'resuming';
        busyUrls.add(args[0]);
      }
    }
    // Once the snapshot-derived container runs, the stopped containers it was
    // committed from are full duplicates of what its image holds.
    if (acting && PARAMS.cleanup && state === 'running') {
      for (const stopped of relatives.filter((c) => c.State === 'exited' && container.Names.startsWith(c.Names + '-resume-'))) {
        const old = stopped.Names;
        try {
          execFileSync('docker', ['rm', old], { encoding: 'utf8' });
          action = (action ? action + '; ' : '') + 'removed superseded container ' + old;
        } catch (error) {
          action = (action ? action + '; ' : '') + 'could not remove ' + old + ': ' + error.message.split('\n')[0];
        }
      }
    }
    results.push({ uuid: e.uuid, name: container?.Names || name, url: args?.[0] || null, exitCode: e.exitCode ?? null, resumes: Number(options.resumeCount) || 0, state, action, container: container?.Status || null });
  }
} finally {
  if (acting) fs.rmSync(LOCK, { recursive: true, force: true });
}
console.log('AF_JSON:' + JSON.stringify({ tasks: results, cleaned, lockNote }));
