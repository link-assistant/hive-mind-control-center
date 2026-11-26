// Runs on the host as root (host Node.js) via auto-fix.mjs, which prepends
// `const PARAMS = { events: [...], out: '/root/auto-fix/facts.json' };`.
// Collects, read-only, what only the host can see about each dead task:
// the container's final state, kernel OOM and Docker daemon journal lines
// around the moment it died, Docker's own log tail (to compare with
// start-command's log), the writable-layer size, uncommitted or unpushed
// work left in its Git work dirs (a stopped container is mounted read-only
// for that; it is never started), and the host's disk and memory now.
// Writes the facts to PARAMS.out and prints one AF_JSON summary line.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const run = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 120000, ...opts });
  return { code: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
};
const lines = (text, max) => text.split('\n').filter(Boolean).slice(-max);
const SNAPSHOTS = '/var/lib/containerd/io.containerd.snapshotter.v1.overlayfs/snapshots';
const sha256File = (file) => {
  try {
    const hash = crypto.createHash('sha256');
    const fd = fs.openSync(file, 'r');
    const buffer = Buffer.alloc(1024 * 1024);
    let read;
    while ((read = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, read));
    fs.closeSync(fd);
    return hash.digest('hex');
  } catch {
    return null;
  }
};
const fileEntry = (dir, name, source) => {
  const file = path.join(dir, name);
  try {
    const stat = fs.statSync(file);
    return { name, bytes: stat.size, sha256: sha256File(file), source };
  } catch {
    return null;
  }
};
const safeKey = (key) => String(key).replace(/[^\w.-]+/g, '_');
const shellRun = (script, args, opts = {}) => run('bash', ['-c', script, 'auto-fix-evidence', ...args], { timeout: 300000, ...opts });
const dockerLogsToFile = (name, since, until, file) => shellRun(
  'args=(logs --timestamps); if [ -n "$1" ]; then args+=(--since "$1"); fi; if [ -n "$2" ]; then args+=(--until "$2"); fi; args+=("$3"); docker "${args[@]}" > "$4" 2>&1',
  [since || '', until || '', name, file]
);
const tailFromFile = (file, max = 80) => {
  try {
    const fd = fs.openSync(file, 'r');
    const { size } = fs.fstatSync(fd);
    const length = Math.min(size, 512 * 1024);
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, size - length);
    fs.closeSync(fd);
    return buffer.toString('utf8').split('\n').filter(Boolean).slice(-max);
  } catch {
    return [];
  }
};
const endsWithNewline = (file) => {
  try {
    const fd = fs.openSync(file, 'r');
    const { size } = fs.fstatSync(fd);
    if (!size) {
      fs.closeSync(fd);
      return true;
    }
    const byte = Buffer.alloc(1);
    fs.readSync(fd, byte, 0, 1, size - 1);
    fs.closeSync(fd);
    return byte[0] === 0x0a;
  } catch {
    return null;
  }
};
const journalToFile = (sinceS, untilS, file) => shellRun(
  '{ echo "### system journal"; journalctl --since "@$1" --until "@$2" -o short-iso --no-pager; echo; echo "### docker and containerd"; journalctl -u docker -u containerd --since "@$1" --until "@$2" -o short-iso --no-pager; echo; echo "### kernel"; journalctl _TRANSPORT=kernel --since "@$1" --until "@$2" -o short-iso --no-pager; echo; echo "### boots"; journalctl --list-boots -o json --no-pager; } > "$3" 2>&1',
  [String(sinceS), String(untilS), file]
);
const inspectToFile = (name, file) => shellRun('docker inspect "$1" > "$2" 2>&1', [name, file]);
const gitEvidenceScript = `for d in "$1"/tmp/gh-issue-solver-*/; do
  [ -e "$d/.git" ] || continue
  g="git -c safe.directory=* -C $d"
  echo "===== \${d#$1} ====="
  echo "--- status"; $g status --porcelain=v2 --branch 2>&1
  echo "--- diff --stat"; $g diff --stat 2>&1
  echo "--- diff --cached --stat"; $g diff --cached --stat 2>&1
  echo "--- log"; $g log -20 --oneline --decorate 2>&1
  echo "--- remote"; $g remote -v 2>&1
  echo "--- diff"; $g diff 2>&1 | head -c 1048576
  echo; echo "--- diff --cached"; $g diff --cached 2>&1 | head -c 1048576
  echo
done`;
const writeText = (file, text) => {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text, { mode: 0o600 });
  } catch {}
};

const inspect = (name) => {
  const r = run('docker', ['inspect', name]);
  if (r.code !== 0) return null;
  const c = JSON.parse(r.out)[0];
  return {
    id: c.Id,
    name: c.Name.replace(/^\//, ''),
    status: c.State.Status,
    exitCode: c.State.ExitCode,
    oomKilled: c.State.OOMKilled,
    startedAt: c.State.StartedAt,
    finishedAt: c.State.FinishedAt,
    pid: c.State.Pid,
    image: c.Config.Image,
    memoryLimit: c.HostConfig.Memory || null,
    nanoCpus: c.HostConfig.NanoCpus || null,
    graphDriver: c.GraphDriver?.Data || null,
  };
};

const journal = (args, sinceS, untilS, pattern) =>
  lines(run('journalctl', [...args, '--since', '@' + sinceS, '--until', '@' + untilS, '-o', 'short-iso', '--no-pager']).out, 2000)
    .filter((l) => pattern.test(l));

// Docker's own record of the container output, with both descriptors on one
// ordered stream. Separate stdout/stderr buffers lose the interleaving of a
// long JSON record split around a stderr line; the file keeps Docker's order.
const dockerLogsTail = (file) => tailFromFile(file, 80);

// containerd's size walk fails (lstat ENOENT) when a running task deletes a
// file during it, about one walk in six on a busy task: retry.
const layerUsage = (id) => {
  for (let attempt = 0; attempt < 4; attempt++) {
    const r = run('ctr', ['-n', 'moby', 'snapshots', '--snapshotter', 'overlayfs', 'usage', id]);
    const m = /\s([\d.]+\s*(?:B|KiB|MiB|GiB|TiB))\s/.exec((r.out.split('\n').pop() || '') + ' ');
    if (m) return m[1];
  }
  return null;
};

// Git state of every solver work dir under `root` (a path on the host, or `/`
// inside a running container when `exec` is set).
const gitScript = `for d in "$1"/tmp/gh-issue-solver-*/; do
  [ -e "$d/.git" ] || continue
  g="git -c safe.directory=* -C $d"
  # Work in submodules shows as one " M modules/x" line above: count inside them
  # too (files, and commits on no remote branch). safe.directory reaches the
  # nested git calls through GIT_CONFIG_PARAMETERS.
  sum() { awk '{ s += $1 } END { print s + 0 }'; }
  sd=$($g submodule foreach --quiet --recursive 'git status --porcelain --ignore-submodules=all | wc -l' 2>/dev/null | sum)
  su=$($g submodule foreach --quiet --recursive 'git rev-list --count HEAD --not --remotes' 2>/dev/null | sum)
  printf '%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n' "\${d#$1}" "$($g branch --show-current 2>/dev/null)" "$($g status --porcelain 2>/dev/null | wc -l)" "$($g rev-list --count @{u}..HEAD 2>/dev/null || echo '?')" "$($g log -1 --format=%cI 2>/dev/null)" "$sd" "$su"
done`;
const parseGit = (out) => lines(out, 50).map((l) => {
  const [dir, branch, dirty, unpushed, lastCommit, subDirty, subUnpushed] = l.split('\t');
  return { dir, branch, dirtyFiles: Number(dirty), unpushedCommits: unpushed === '?' ? null : Number(unpushed), lastCommit, submoduleDirtyFiles: Number(subDirty) || 0, submoduleUnpushedCommits: Number(subUnpushed) || 0 };
});

// A stopped container is mounted read-only from its snapshot. The layer list
// is passed relative to the snapshots dir (like containerd does): 70+ absolute
// layer paths overflow the 4 KiB mount options and the mount fails.
const workState = (c, evidenceFile = null) => {
  if (c.status === 'running') {
    if (evidenceFile) writeText(evidenceFile, run('docker', ['exec', c.name, 'bash', '-c', gitEvidenceScript, 'git-evidence', '']).out);
    const r = run('docker', ['exec', c.name, 'bash', '-c', gitScript, 'git-state', '']);
    return { via: 'docker exec', repos: parseGit(r.out) };
  }
  const spec = run('ctr', ['-n', 'moby', 'snapshots', '--snapshotter', 'overlayfs', 'mounts', '/af-mnt', c.id]).out;
  const upper = /upperdir=([^,\s]+)/.exec(spec)?.[1];
  const lower = /lowerdir=([^,\s]+)/.exec(spec)?.[1];
  if (!upper || !lower) return { via: 'none', error: 'no snapshot mount spec' };
  const rel = (p) => p.split(':').map((x) => x.startsWith(SNAPSHOTS + '/') ? x.slice(SNAPSHOTS.length + 1) : x).join(':');
  const mnt = fs.mkdtempSync(path.join(os.tmpdir(), 'af-mnt-'));
  try {
    const m = run('mount', ['-t', 'overlay', 'overlay', '-o', 'ro,lowerdir=' + rel(upper) + ':' + rel(lower), mnt], { cwd: SNAPSHOTS });
    if (m.code !== 0) return { via: 'read-only mount', error: m.err || 'mount failed' };
    if (evidenceFile) writeText(evidenceFile, run('bash', ['-c', gitEvidenceScript, 'git-evidence', mnt]).out);
    return { via: 'read-only mount', repos: parseGit(run('bash', ['-c', gitScript, 'git-state', mnt]).out) };
  } finally {
    // A git process can still hold the mount for a moment: retry, then detach
    // it lazily. The mount point is removed with rmdir only, never
    // recursively, so a still-mounted container filesystem is never walked.
    for (let i = 0; i < 5 && run('mountpoint', ['-q', mnt]).code === 0; i++) {
      if (run('umount', [mnt]).code !== 0) spawnSync('sleep', ['1']);
    }
    if (run('mountpoint', ['-q', mnt]).code === 0) run('umount', ['-l', mnt]);
    try {
      fs.rmdirSync(mnt);
    } catch {}
  }
};

const df = run('df', ['-B1', '--output=size,avail', '/']).out.split('\n').pop().trim().split(/\s+/).map(Number);
const meminfo = Object.fromEntries(fs.readFileSync('/proc/meminfo', 'utf8').split('\n').filter(Boolean)
  .map((l) => l.split(':')).map(([k, v]) => [k, Number.parseInt(v, 10) * 1024]));
const system = {
  diskTotal: df[0],
  diskFree: df[1],
  memTotal: meminfo.MemTotal,
  memAvailable: meminfo.MemAvailable,
  load: os.loadavg().map((x) => x.toFixed(2)).join(' '),
  liveRestore: run('docker', ['info', '-f', '{{.LiveRestoreEnabled}}']).out,
};

// Every boot the journal knows, and whether it ended with a shutdown: a boot
// whose journal just stops was a hard reset (hypervisor, power, kernel hang),
// which kills every task the same way a dockerd restart does (exit 255/137).
let boots = [];
try {
  boots = JSON.parse(run('journalctl', ['--list-boots', '-o', 'json', '--no-pager']).out || '[]');
} catch {}
const bootGaps = boots.slice(0, -1).map((b, i) => ({ bootId: b.boot_id, endedAt: b.last_entry / 1000, nextBootAt: boots[i + 1].first_entry / 1000 }));
const endedCleanly = (bootId) => /Journal stopped|systemd-shutdown|Reached target .*(Shutdown|Power-Off|Reboot)/
  .test(run('journalctl', ['-b', bootId, '-n', '15', '-o', 'short-iso', '--no-pager']).out);

if (PARAMS.evidenceDir) {
  fs.rmSync(PARAMS.evidenceDir, { recursive: true, force: true });
  fs.mkdirSync(PARAMS.evidenceDir, { recursive: true, mode: 0o700 });
}
const facts = {};
for (const ev of PARAMS.events) {
  const containers = ev.containerNames.map(inspect).filter(Boolean);
  const main = containers.find((c) => c.name === ev.sessionName) || null;
  const dockerMain = main || containers[0] || null;
  const finished = Date.parse(ev.finishedAt || '') || Date.parse(main?.finishedAt || '') || Date.now();
  const t = Math.floor(finished / 1000);
  const shortId = main?.id?.slice(0, 12);
  const evidenceDir = PARAMS.evidenceDir ? path.join(PARAMS.evidenceDir, safeKey(ev.key)) : null;
  const evidenceFiles = [];
  if (evidenceDir) {
    fs.rmSync(evidenceDir, { recursive: true, force: true });
    fs.mkdirSync(evidenceDir, { recursive: true, mode: 0o700 });
    writeText(path.join(evidenceDir, 'event.json'), JSON.stringify(ev, null, 2) + '\n');
    evidenceFiles.push(fileEntry(evidenceDir, 'event.json', 'auto-fix candidate event'));
  }
  const since = ev.startedAt || main?.startedAt || '';
  const until = ev.finishedAt || main?.finishedAt || '';
  if (evidenceDir) {
    for (const c of containers) {
      const name = c === dockerMain ? 'docker.log' : `docker-${c.name}.log`;
      dockerLogsToFile(c.name, since, until, path.join(evidenceDir, name));
      evidenceFiles.push(fileEntry(evidenceDir, name, `docker logs ${c.name} (${since || 'start'}..${until || 'end'})`));
      const inspectName = c === dockerMain ? 'inspect.json' : `inspect-${c.name}.json`;
      inspectToFile(c.name, path.join(evidenceDir, inspectName));
      evidenceFiles.push(fileEntry(evidenceDir, inspectName, `docker inspect ${c.name}`));
    }
    journalToFile(t - 600, t + 300, path.join(evidenceDir, 'journal.log'));
    evidenceFiles.push(fileEntry(evidenceDir, 'journal.log', `journal ${new Date((t - 600) * 1000).toISOString()}..${new Date((t + 300) * 1000).toISOString()}`));
  }
  // `-k` means `-b -k`: only the current boot, so a kill just before a
  // reboot would be missed. The transport match spans every boot.
  const kernel = journal(['_TRANSPORT=kernel'], t - 600, t + 120, /Out of memory|oom-kill|oom_reaper|Memory cgroup out of memory|Killed process/);
  const daemon = journal(['-u', 'docker', '-u', 'containerd'], t - 600, t + 300,
    /Main process exited|killed by the OOM|Started docker|Loading containers: start|Scheduled restart|failed to exit within/);
  facts[ev.key] = {
    container: main,
    otherContainers: containers.filter((c) => c !== main).map((c) => ({ name: c.name, status: c.status, exitCode: c.exitCode })),
    kernel: kernel.slice(-30),
    containerOomLines: shortId ? kernel.filter((l) => l.includes(shortId) || l.includes(main.id)) : [],
    globalOom: kernel.filter((l) => /Out of memory: Killed process/.test(l)),
    daemon: daemon.slice(-20),
    hostReboot: (() => {
      // The boot that ended while the task ran; Docker records the exit only
      // once it starts again, so `finished` can be just after the next boot.
      const started = Date.parse(ev.startedAt || '') || 0;
      const gap = bootGaps.find((b) => b.endedAt > started && b.endedAt < finished + 120000 && b.nextBootAt > finished - 30 * 60000);
      return gap ? { lastEntryAt: new Date(gap.endedAt).toISOString(), nextBootAt: new Date(gap.nextBootAt).toISOString(), clean: endedCleanly(gap.bootId) } : null;
    })(),
    daemonRestartNear: daemon.some((l) => {
      const at = Date.parse(l.split(' ')[0]);
      return /Main process exited|Started docker|Loading containers: start/.test(l) && Math.abs(at - finished) < 120000;
    }),
    dockerLogsTail: evidenceDir ? dockerLogsTail(path.join(evidenceDir, 'docker.log')) : main ? [] : [],
    dockerLogsEndsWithNewline: evidenceDir ? endsWithNewline(path.join(evidenceDir, 'docker.log')) : null,
    layer: main ? layerUsage(main.id) : null,
    work: main ? workState(main, evidenceDir ? path.join(evidenceDir, 'git.txt') : null) : { via: 'none', error: 'container removed' },
    evidence: evidenceDir ? { dir: evidenceDir, files: evidenceFiles } : null,
  };
  if (evidenceDir) {
    const git = fileEntry(evidenceDir, 'git.txt', 'git status, diff, log and remotes');
    if (git) evidenceFiles.push(git);
    writeText(path.join(evidenceDir, 'facts.json'), JSON.stringify({ system, facts: facts[ev.key] }, null, 2) + '\n');
    evidenceFiles.push(fileEntry(evidenceDir, 'facts.json', 'host facts for this attempt'));
    const manifest = {
      schema: 'auto-fix-incident-evidence-v1',
      key: ev.key,
      uuid: ev.uuid,
      attempt: ev.attempt,
      generatedAt: new Date().toISOString(),
      files: evidenceFiles.filter(Boolean),
    };
    writeText(path.join(evidenceDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  }
}
fs.mkdirSync(path.dirname(PARAMS.out), { recursive: true });
fs.writeFileSync(PARAMS.out, JSON.stringify({ system, facts }));
console.log('AF_JSON:' + JSON.stringify({ count: Object.keys(facts).length, out: PARAMS.out }));
