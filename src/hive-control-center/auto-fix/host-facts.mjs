// Runs on the host as root (host Node.js) via auto-fix.mjs, which prepends
// `const PARAMS = { events: [...], out: '/root/auto-fix/facts.json' };`.
// Collects, read-only, what only the host can see about each dead task:
// the container's final state, kernel OOM and Docker daemon journal lines
// around the moment it died, Docker's own log tail (to compare with
// start-command's log), the writable-layer size, uncommitted or unpushed
// work left in its Git work dirs (a stopped container is mounted read-only
// for that; it is never started), and the host's disk and memory now.
// Writes the facts to PARAMS.out and prints one AF_JSON summary line.
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

// Docker's own record of the container output (stdout and stderr), to compare
// with the end of start-command's log file.
const dockerLogsTail = (name) => {
  const r = run('docker', ['logs', '--timestamps', '--tail', '80', name]);
  return lines(r.out + '\n' + r.err, 80).sort();
};

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
const workState = (c) => {
  if (c.status === 'running') {
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

const facts = {};
for (const ev of PARAMS.events) {
  const containers = ev.containerNames.map(inspect).filter(Boolean);
  const main = containers.find((c) => c.name === ev.sessionName) || null;
  const finished = Date.parse(ev.finishedAt || '') || Date.parse(main?.finishedAt || '') || Date.now();
  const t = Math.floor(finished / 1000);
  const shortId = main?.id?.slice(0, 12);
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
    dockerLogsTail: main ? dockerLogsTail(main.name) : [],
    layer: main ? layerUsage(main.id) : null,
    work: main ? workState(main) : { via: 'none', error: 'container removed' },
  };
}
fs.mkdirSync(path.dirname(PARAMS.out), { recursive: true });
fs.writeFileSync(PARAMS.out, JSON.stringify({ system, facts }));
console.log('AF_JSON:' + JSON.stringify({ count: Object.keys(facts).length, out: PARAMS.out }));
