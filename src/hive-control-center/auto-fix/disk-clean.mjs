// Runs on the host as root (host Node.js) via auto-fix.mjs, which prepends
// `const PARAMS = {...};`. Safe disk cleanup with disk-space-saviour (dss),
// across the host and every running container:
//   1. Fetches the pinned dss release from npm and checks its sha512.
//   2. Host: `dss clean --tier safe --no-docker`, with Docker's and
//      containerd's own storage excluded. Containers are not cleaned through
//      Docker: dss's own recursion walks every container with `docker diff`,
//      and concurrent `docker diff` calls are what got dockerd OOM-killed on
//      2026-10-09 (link-foundation/disk-space-saviour#22, #33, #36).
//   3. Each running container: `dss scan --tier safe` inside it, as root with
//      the box user's HOME. Its safe, unblocked items are measured in the
//      container's writable layer on the host, and only what really takes
//      space there is deleted (a cache that lives in the image would only get
//      a whiteout and free nothing, and a file hard-linked from elsewhere, like
//      bun's cache linked into its installed packages, keeps its blocks), in
//      one `docker exec ... xargs -0 rm -rf`.
//   4. Journal vacuum to PARAMS.journalKeepDays (after the reports, which read
//      the journal).
// A guard kills dss when dockerd or the host runs short of memory, and every
// dss run has a hard timeout (dss ignores SIGTERM during scans, #34).
// Every dss run is `--fresh`: no scan reused from dss's cache (0.17.0+) and no
// scan state written into the host's or a container's home.
// With PARAMS.dry nothing is deleted. Prints one AF_JSON line.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';

const run = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, ...opts });
  return { code: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
};
const SNAPSHOTS = '/var/lib/containerd/io.containerd.snapshotter.v1.overlayfs/snapshots';
const WORK = '/root/auto-fix';
const DSS = `${WORK}/dss-${PARAMS.version}`;
const freeBytes = () => Number(run('df', ['-B1', '--output=avail', '/']).out.split('\n').pop());
const memAvailableMb = () => Number(/MemAvailable:\s+(\d+)/.exec(fs.readFileSync('/proc/meminfo', 'utf8'))[1]) / 1024;
const dockerdRssMb = () => Math.max(0, ...run('ps', ['-o', 'rss=', '-C', 'dockerd']).out.split('\n').map(Number).filter(Boolean)) / 1024;
const notes = [];

// 1. dss, pinned and verified.
if (!fs.existsSync(`${DSS}/bin/dss.js`)) {
  fs.mkdirSync(WORK, { recursive: true });
  const tgz = `${WORK}/dss-${PARAMS.version}.tgz`;
  const got = run('curl', ['-fsSL', '--retry', '3', '-o', tgz, PARAMS.tarballUrl]);
  if (got.code !== 0) throw new Error('dss download failed: ' + got.err);
  const integrity = 'sha512-' + crypto.createHash('sha512').update(fs.readFileSync(tgz)).digest('base64');
  if (integrity !== PARAMS.integrity) {
    fs.rmSync(tgz, { force: true });
    throw new Error('dss tarball integrity mismatch: ' + integrity);
  }
  fs.mkdirSync(DSS, { recursive: true });
  const x = run('tar', ['-xzf', tgz, '-C', DSS, '--strip-components', '1']);
  fs.rmSync(tgz, { force: true });
  if (x.code !== 0) throw new Error('dss extract failed: ' + x.err);
}

// dss with a memory guard and a hard timeout; resolves with its stdout.
// `env` reaches only the process started here: for the host dss run a dead
// DOCKER_HOST keeps dss away from dockerd; inside a container it is passed
// with `docker exec -e` instead, since the docker CLI itself needs the daemon.
const guarded = (cmd, args, timeoutS, env = {}) => new Promise((resolve) => {
  const child = spawn('timeout', ['-k', '30', String(timeoutS), 'nice', '-n', '10', 'ionice', '-c3', cmd, ...args], {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd: '/root',
  });
  let out = '';
  let err = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (err += d.toString().slice(-2000)));
  const guard = setInterval(() => {
    const rss = dockerdRssMb();
    const avail = memAvailableMb();
    if (rss > PARAMS.maxDockerdRssMb || avail < PARAMS.minMemAvailableMb) {
      notes.push(`guard stopped ${args.join(' ').slice(0, 60)}: dockerd ${Math.round(rss)} MB, MemAvailable ${Math.round(avail)} MB`);
      child.kill('SIGKILL');
    }
  }, 2000);
  child.on('close', (code) => {
    clearInterval(guard);
    resolve({ code, out, err });
  });
});
const parseJson = (text) => {
  try {
    return JSON.parse(text.slice(text.indexOf('{')));
  } catch {
    return null;
  }
};

const before = freeBytes();
const summary = { host: null, containers: [], journal: null };

// 2. Host.
const excludes = ['/var/lib/containerd', '/var/lib/docker', '/tmp/containerd-mount*', '/run/containerd', '/root/auto-fix'].flatMap((p) => ['--exclude', p]);
const hostArgs = [`${DSS}/bin/dss.js`, PARAMS.dry ? 'scan' : 'clean', '--no-docker', '--fresh', '--json', '--tier', 'safe', ...excludes, ...(PARAMS.dry ? [] : ['-y'])];
const host = await guarded('node', hostArgs, PARAMS.hostTimeoutS, { DOCKER_HOST: 'unix:///nonexistent.sock' });
// `scan --json` prints the report (items), `clean --json` the audit log
// (entries with freedBytes).
const hostReport = parseJson(host.out);
const hostSafe = (hostReport?.items || []).filter((i) => !i.parentId && i.tier === 'safe' && !(i.blockers || []).length);
const hostDeleted = (hostReport?.entries || []).filter((e) => e.status !== 'skipped');
summary.host = {
  exit: host.code,
  items: PARAMS.dry ? hostSafe.length : hostDeleted.length,
  bytes: PARAMS.dry ? hostSafe.reduce((s, i) => s + (i.bytes || 0), 0) : hostReport?.freedBytes ?? hostDeleted.reduce((s, e) => s + (e.freedBytes || 0), 0),
  error: host.code === 0 && hostReport ? null : (host.err.split('\n').filter(Boolean).pop() || 'exit ' + host.code),
};

// 3. Running containers.
const upperOf = (id) => {
  const spec = run('ctr', ['-n', 'moby', 'snapshots', '--snapshotter', 'overlayfs', 'mounts', '/af', id]).out;
  const upper = /upperdir=([^,\s]+)/.exec(spec)?.[1];
  if (!upper) return null;
  return upper.startsWith('/') ? upper : path.join(SNAPSHOTS, upper);
};
// What deleting `p` really frees: the allocated blocks of its files that have
// no other hard link (`du` would count a linked file's blocks in full).
const freeableBytes = (p) => run('find', [p, '-type', 'f', '-links', '1', '-printf', '%b\n']).out
  .split('\n').reduce((sum, blocks) => sum + (Number(blocks) || 0) * 512, 0);
const sanePath = (p) => typeof p === 'string' && p.startsWith('/') && !p.includes('\0') && !/(^|\/)\.\.(\/|$)/.test(p)
  && p.split('/').filter(Boolean).length >= 2 && !/^\/(proc|sys|dev|run|etc|bin|sbin|lib|lib64|usr\/bin|boot)(\/|$)/.test(p);

for (const line of run('docker', ['ps', '--format', '{{.Names}}\t{{.State}}']).out.split('\n').filter(Boolean)) {
  const [name, state] = line.split('\t');
  const entry = { name, candidates: 0, deleted: 0, bytes: 0, error: null };
  summary.containers.push(entry);
  // `docker ps` also lists paused containers, but `docker exec` cannot enter
  // them; skip them instead of reporting a misleading "no node in container".
  if (state !== 'running') {
    entry.error = `not running (${state}); skipped`;
    continue;
  }
  const id = run('docker', ['inspect', '-f', '{{.Id}}', name]).out;
  const upper = upperOf(id);
  if (!upper || !fs.existsSync(upper)) {
    // A task that finishes during the cleanup is removed by start-command.
    const currentState = run('docker', ['inspect', '-f', '{{.State.Status}}', name]);
    entry.error = currentState.code !== 0 ? 'finished and removed during the cleanup; skipped' : currentState.out !== 'running' ? 'stopped during the cleanup (' + currentState.out + '); skipped' : 'writable layer not found';
    continue;
  }
  if (run('docker', ['exec', name, 'sh', '-c', 'command -v node']).code !== 0) {
    entry.error = 'no node in container';
    continue;
  }
  run('docker', ['exec', '-u', '0', name, 'rm', '-rf', '/tmp/af-dss']);
  if (run('docker', ['cp', DSS, `${name}:/tmp/af-dss`]).code !== 0) {
    entry.error = 'could not copy dss';
    continue;
  }
  // dss blocks every path a process it cannot inspect might use ("unreadable
  // process ... may use"). In a privileged container root sees every process.
  // Otherwise `docker exec` has no CAP_SYS_PTRACE and root cannot read another
  // user's /proc/<pid>/cwd, so the scan runs as the user of the container's
  // main process (the bot container). Deleting always runs as root.
  const privileged = run('docker', ['inspect', '-f', '{{.HostConfig.Privileged}}', name]).out === 'true';
  const uid = privileged ? '0' : run('docker', ['exec', '-u', '0', name, 'stat', '-c', '%u', '/proc/1']).out || '0';
  // dss's own audit log goes to a private dir: a scan aborts when it cannot
  // write it (e.g. a root-owned ~/.local/state/disk-space-saviour).
  run('docker', ['exec', '-u', '0', name, 'sh', '-c', `mkdir -p /tmp/af-dss/audit && chmod -R a+rX /tmp/af-dss && chown -R ${Number(uid)} /tmp/af-dss/audit`]);
  const scan = await guarded('docker', ['exec', '-u', uid, '-e', 'HOME=/home/box', '-e', 'DOCKER_HOST=unix:///nonexistent.sock', name,
    'node', '/tmp/af-dss/bin/dss.js', 'scan', '--no-docker', '--fresh', '--json', '--tier', 'safe', '--exclude', '/tmp/af-dss', '--audit-dir', '/tmp/af-dss/audit'], PARAMS.containerTimeoutS);
  const report = parseJson(scan.out);
  if (!report) {
    entry.error = 'scan failed: ' + (scan.err.split('\n').filter(Boolean).pop() || 'exit ' + scan.code);
    run('docker', ['exec', '-u', '0', name, 'rm', '-rf', '/tmp/af-dss']);
    continue;
  }
  const items = (report.items || []).filter((i) => !i.parentId && i.tier === 'safe' && !(i.blockers || []).length && sanePath(i.path));
  entry.candidates = items.length;
  entry.blocked = (report.items || []).filter((i) => !i.parentId && i.tier === 'safe' && (i.blockers || []).length).length;
  const victims = [];
  for (const item of items) {
    const bytes = freeableBytes(path.join(upper, item.path));
    if (bytes >= PARAMS.minItemMb * 2 ** 20) victims.push({ path: item.path, bytes, rule: item.rule });
  }
  entry.bytes = victims.reduce((s, v) => s + v.bytes, 0);
  entry.top = victims.sort((a, b) => b.bytes - a.bytes).slice(0, 5).map((v) => `${(v.bytes / 2 ** 20).toFixed(0)} MiB ${v.rule} ${v.path}`);
  if (!PARAMS.dry && victims.length) {
    const list = `${WORK}/rm-${name}.list`;
    fs.writeFileSync(list, victims.map((v) => v.path).join('\0') + '\0');
    run('docker', ['cp', list, `${name}:/tmp/af-rm.list`]);
    const rm = run('docker', ['exec', '-u', '0', name, 'sh', '-c', 'xargs -0 rm -rf -- < /tmp/af-rm.list; rm -f /tmp/af-rm.list']);
    fs.rmSync(list, { force: true });
    entry.deleted = victims.length;
    if (rm.code !== 0) entry.error = 'rm: ' + rm.err.split('\n')[0];
  }
  run('docker', ['exec', '-u', '0', name, 'rm', '-rf', '/tmp/af-dss']);
}

// 4. Journal.
if (PARAMS.journalKeepDays > 0) {
  const usage = () => run('journalctl', ['--disk-usage']).out.replace(/^.*take up /, '').replace(/ in the file system\.$/, '');
  const was = usage();
  if (!PARAMS.dry) run('journalctl', [`--vacuum-time=${PARAMS.journalKeepDays}d`]);
  summary.journal = PARAMS.dry ? `${was} (would vacuum to ${PARAMS.journalKeepDays} days)` : `${was} -> ${usage()}`;
}

summary.freedBytes = freeBytes() - before;
summary.freeBytes = freeBytes();
summary.notes = notes;
console.log('AF_JSON:' + JSON.stringify(summary));
