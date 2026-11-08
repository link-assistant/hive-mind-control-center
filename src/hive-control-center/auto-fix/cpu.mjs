// Runs on the host as root (host Node.js) via auto-fix.mjs, which prepends
// `const PARAMS = { sampleSeconds: 5, top: 5, hogPercent: 90, hogAveragePercent: 80, hogMinutes: 30 };`.
// Read-only: samples /proc twice to find what uses the CPU right now, maps each
// process to its container (and a task container to its `solve` URL), and
// flags "hogs": processes that use a whole core now and have done so for most
// of a long life, the sign of a busy loop (2026-10-20: the Formal AI sidecar
// at 100% for 4 h, answering a Codex task that repeated one failing web_run
// call 112 times). Nothing is stopped or reniced. Prints one AF_JSON line.
// A hog is sampled again: its busy thread, whether it makes system calls at
// all, and which program is blocked writing to it because it stopped reading
// (2026-10-24: a solve at 100% for 5 h left Claude's output unread, so the AI
// session waited on a full socket).
// Blocked output is looked for in every container, busy or not: a program
// whose output nobody reads uses no CPU while it waits, and its reader can be
// quiet in the sample too.
import fs from 'node:fs';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

const HZ = 100; // USER_HZ, 100 on every Linux build Docker supports
const run = (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 30000 });
  return r.status === 0 ? (r.stdout || '').trim() : '';
};
const read = (file) => { try { return fs.readFileSync(file, 'utf8'); } catch { return null; } };
// Command lines can carry tokens; keep the shape, drop the values.
const redact = (text) => text
  .replace(/\b(gh[pousr]_|github_pat_)[A-Za-z0-9_]+/g, '$1***')
  .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, 'sk-***')
  .replace(/\b\d{6,}:[A-Za-z0-9_-]{30,}\b/g, '***:***')
  .replace(/((?:token|password|passwd|secret|api[_-]?key)[=: ]+)\S+/gi, '$1***');

const snapshot = () => {
  const procs = new Map();
  for (const pid of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(pid)) continue;
    const stat = read(`/proc/${pid}/stat`);
    if (!stat) continue;
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    procs.set(Number(pid), {
      comm: stat.slice(stat.indexOf('(') + 1, stat.lastIndexOf(')')),
      ticks: Number(fields[11]) + Number(fields[12]), // utime + stime, all threads
      startTicks: Number(fields[19]),
    });
  }
  return procs;
};

// Host CPU time from /proc/stat: the load average is demand (runnable plus
// I/O-waiting threads), not CPU used (hive-mind#3582).
const cpuTicks = () => {
  const [user, nice, system, idle, iowait, irq, softirq, steal] = read('/proc/stat').split('\n')[0].trim().split(/\s+/).slice(1).map(Number);
  // Exact run time of all tasks per CPU (ns): busy ticks miss runs shorter
  // than a tick on a tickless kernel.
  const run = (read('/proc/schedstat') || '').split('\n').filter((l) => /^cpu\d/.test(l)).reduce((a, l) => a + Number(l.split(' ')[7] || 0), 0);
  return { busy: user + nice + system + irq + softirq + steal, all: user + nice + system + idle + iowait + irq + softirq + steal, iowait, irq: irq + softirq, run, at: Date.now() };
};
// CPU time per cgroup (each container's scope, dockerd, containerd, sshd, user
// sessions) from cgroup v2 cpu.stat: unlike a sum over live processes it
// includes processes that started and exited inside the window, such as the
// docker CLI calls of start-command's monitor loops.
const CGROUP = '/sys/fs/cgroup';
const cgroupUsage = () => {
  const usage = new Map();
  const dirs = [];
  try { for (const d of fs.readdirSync(`${CGROUP}/system.slice`)) dirs.push(`system.slice/${d}`); } catch {}
  dirs.push('user.slice', 'init.scope');
  for (const dir of dirs) {
    const usec = /^usage_usec (\d+)/m.exec(read(`${CGROUP}/${dir}/cpu.stat`) || '')?.[1];
    // Time at least one of its threads was ready to run but had no CPU.
    const wait = /^some .*total=(\d+)/m.exec(read(`${CGROUP}/${dir}/cpu.pressure`) || '')?.[1];
    if (usec) usage.set(dir, { usec: Number(usec), wait: wait === undefined ? null : Number(wait) });
  }
  return usage;
};
const cgroupsBefore = cgroupUsage();
const before = snapshot();
const ticksBefore = cpuTicks();
const t0 = Date.now();
await new Promise((resolve) => setTimeout(resolve, (PARAMS.sampleSeconds || 5) * 1000));
const after = snapshot();
const ticksAfter = cpuTicks();
const cgroupsAfter = cgroupUsage();
const allTicks = ticksAfter.all - ticksBefore.all || 1;
const runSeconds = (ticksAfter.at - ticksBefore.at) / 1000;
const busyPercent = ticksAfter.run > ticksBefore.run
  ? Math.round((((ticksAfter.run - ticksBefore.run) / 1e9 / runSeconds) / os.cpus().length + (ticksAfter.irq - ticksBefore.irq) / allTicks) * 100)
  : Math.round(((ticksAfter.busy - ticksBefore.busy) / allTicks) * 100);
const iowaitPercent = Math.round(((ticksAfter.iowait - ticksBefore.iowait) / allTicks) * 100);
// Share of time some task waited for a CPU (pressure stall information).
const pressure = Number(/^some .*avg60=([\d.]+)/m.exec(read('/proc/pressure/cpu') || '')?.[1] ?? NaN);
const seconds = (Date.now() - t0) / 1000;
const uptime = Number(read('/proc/uptime').split(' ')[0]);

const names = new Map(run('docker', ['ps', '--no-trunc', '--format', '{{.ID}} {{.Names}}']).split('\n').filter(Boolean).map((l) => l.split(' ')));
const containerOf = (pid) => {
  const id = /([0-9a-f]{64})/.exec(read(`/proc/${pid}/cgroup`) || '')?.[1];
  return id ? names.get(id) || id.slice(0, 12) : null;
};

const procs = [];
for (const [pid, b] of after) {
  const a = before.get(pid);
  if (!a || a.startTicks !== b.startTicks) continue;
  const percent = ((b.ticks - a.ticks) / HZ / seconds) * 100;
  if (percent < 1) continue;
  const elapsed = uptime - b.startTicks / HZ;
  procs.push({
    pid,
    comm: b.comm,
    percent: Math.round(percent),
    cpuMinutes: Math.round(b.ticks / HZ / 60),
    elapsedMinutes: Math.round(elapsed / 60),
    averagePercent: elapsed > 0 ? Math.round((b.ticks / HZ / elapsed) * 100) : 0,
    // The bot's cmdline carries a multi-line configuration: keep the first line only.
    command: redact((read(`/proc/${pid}/cmdline`) || '').split('\n')[0].replace(/\0/g, ' ').trim()).slice(0, 160),
    container: containerOf(pid),
  });
}
procs.sort((x, y) => y.percent - x.percent);

const cgroups = [];
for (const [dir, b] of cgroupsAfter) {
  const a = cgroupsBefore.get(dir) ?? b;
  const cores = (b.usec - a.usec) / 1e6 / seconds;
  const id = /docker-([0-9a-f]{64})\.scope$/.exec(dir)?.[1];
  if (cores < 0.02 && !id) continue; // every container, services only when busy
  const waitedPercent = b.wait !== null && a.wait !== null ? Math.round(((b.wait - a.wait) / 1e6 / seconds) * 100) : null;
  cgroups.push({ name: id ? names.get(id) || id.slice(0, 12) : dir.replace(/^system\.slice\//, ''), container: Boolean(id), cores: Math.round(cores * 100) / 100, waitedPercent });
}
cgroups.sort((x, y) => y.cores - x.cores);

// A task container's own command names the work: `solve <url> --tool X --model Y`.
const describe = (container) => {
  if (!container) return null;
  const cmd = run('docker', ['inspect', '-f', '{{json .Config.Cmd}}', container]);
  const url = /'solve' '([^']+)'/.exec(cmd)?.[1] || /"solve","([^"]+)"/.exec(cmd)?.[1];
  if (!url) return null;
  const opt = (name) => new RegExp(`'--${name}' '([^']+)'`).exec(cmd)?.[1];
  return [url, opt('tool') && `--tool ${opt('tool')}`, opt('model') && `--model ${opt('model')}`].filter(Boolean).join(' ');
};

// A server process (the Formal AI sidecar) burns CPU for whoever is connected:
// name the containers on the other end of its established TCP connections.
let ipNames = null;
const peersOf = (pid) => {
  if (!ipNames) {
    ipNames = new Map();
    for (const line of run('sh', ['-c', `docker ps -q | xargs -r docker inspect -f '{{.Name}}{{range .NetworkSettings.Networks}} {{.IPAddress}}{{end}}'`]).split('\n')) {
      const [name, ...ips] = line.trim().split(' ');
      for (const ip of ips) if (ip) ipNames.set(ip, name.replace(/^\//, ''));
    }
  }
  const hexIp = (hex) => hex.match(/../g).reverse().map((h) => parseInt(h, 16)).join('.');
  // /proc/<pid>/net/tcp is the table of the process's own network namespace.
  const sockets = (read(`/proc/${pid}/net/tcp`) || '').split('\n').slice(1).map((l) => l.trim().split(/\s+/)).filter((f) => f.length > 3);
  const listening = new Set(sockets.filter((f) => f[3] === '0A').map((f) => f[1].split(':')[1]));
  const peers = new Set();
  for (const [, local, remote, state] of sockets) {
    if (state !== '01' || !listening.has(local.split(':')[1])) continue; // inbound ESTABLISHED only
    const ip = hexIp(remote.split(':')[0]);
    peers.add(ipNames.get(ip) || ip);
  }
  return [...peers];
};

// A hog, sampled again: the threads that burn the CPU and its system calls.
const kvFile = (file) => Object.fromEntries((read(file) || '').split('\n').filter(Boolean).map((l) => l.split(/:\s*/)).map(([k, v]) => [k, Number(v)]));
const probe = (pid) => {
  const threads = new Map();
  try {
    for (const tid of fs.readdirSync(`/proc/${pid}/task`)) {
      const stat = read(`/proc/${pid}/task/${tid}/stat`);
      if (!stat) continue;
      const f = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      threads.set(tid, { comm: stat.slice(stat.indexOf('(') + 1, stat.lastIndexOf(')')), ticks: Number(f[11]) + Number(f[12]) });
    }
  } catch {}
  const io = kvFile(`/proc/${pid}/io`); // whole process, all threads
  return { threads, syscalls: (io.syscr || 0) + (io.syscw || 0), at: Date.now() };
};
// Unix sockets of the hog with unread bytes, and the program writing to them
// (`ss` in the hog's network namespace: queue sizes are not in /proc).
const backlog = (pid) => {
  const fds = new Map();
  try {
    for (const fd of fs.readdirSync(`/proc/${pid}/fd`)) {
      const inode = /^socket:\[(\d+)\]$/.exec(fs.readlinkSync(`/proc/${pid}/fd/${fd}`))?.[1];
      if (inode) fds.set(inode, Number(fd));
    }
  } catch {}
  if (!fds.size) return [];
  const sockets = new Map();
  for (const line of run('nsenter', ['-t', String(pid), '-n', 'ss', '-xpH']).split('\n')) {
    const f = line.trim().split(/\s+/);
    if (f.length < 8) continue;
    sockets.set(f[5], { recvQ: Number(f[2]), sendQ: Number(f[3]), peer: f[7], users: [...line.matchAll(/\("([^"]+)",pid=(\d+),fd=(\d+)\)/g)].map((m) => ({ comm: m[1], pid: Number(m[2]), fd: Number(m[3]) })) });
  }
  const out = [];
  for (const [inode, fd] of fds) {
    const s = sockets.get(inode);
    if (!s || s.recvQ <= 0) continue;
    const peer = sockets.get(s.peer);
    const writer = (peer?.users || []).find((u) => u.pid !== pid);
    out.push({
      fd, unread: s.recvQ, writerQueued: peer?.sendQ ?? null,
      writer: writer ? { pid: writer.pid, comm: writer.comm, fds: [...new Set(peer.users.filter((u) => u.pid === writer.pid).map((u) => u.fd))].sort((x, y) => x - y), wchan: (read(`/proc/${writer.pid}/wchan`) || '').trim() || null } : null,
    });
  }
  return out.sort((x, y) => y.unread - x.unread).slice(0, 3);
};

const hogs = procs
  .filter((p) => p.percent >= (PARAMS.hogPercent ?? 90) && p.averagePercent >= (PARAMS.hogAveragePercent ?? 80) && p.elapsedMinutes >= (PARAMS.hogMinutes ?? 30))
  .map((p) => {
    const peers = p.container ? peersOf(p.pid) : [];
    return { ...p, task: describe(p.container), peers: peers.map((name) => ({ name, task: describe(name) })) };
  });
if (hogs.length) {
  const first = hogs.map((h) => probe(h.pid));
  await new Promise((resolve) => setTimeout(resolve, 2000));
  hogs.forEach((h, i) => {
    const a = first[i];
    const b = probe(h.pid);
    const sec = (b.at - a.at) / 1000;
    h.followSeconds = Math.round(sec * 10) / 10;
    h.threads = [...b.threads].map(([tid, t]) => ({ tid: Number(tid), comm: t.comm, cores: Math.round(((t.ticks - (a.threads.get(tid)?.ticks ?? t.ticks)) / HZ / sec) * 100) / 100 })).filter((t) => t.cores >= 0.05).sort((x, y) => y.cores - x.cores);
    h.syscallsPerSecond = Math.round(((b.syscalls - a.syscalls) / sec) * 10) / 10;
    h.backlog = backlog(h.pid);
  });
}

// Blocked output in every container: a socket whose reader has left 16 KB+
// unread for 2 s while the writer's own queue is full too (the writer waits).
const socketTable = (pid) => {
  const sockets = new Map();
  for (const line of run('nsenter', ['-t', String(pid), '-n', 'ss', '-xpH']).split('\n')) {
    const f = line.trim().split(/\s+/);
    if (f.length < 8) continue;
    sockets.set(f[5], { recvQ: Number(f[2]), sendQ: Number(f[3]), peer: f[7], users: [...line.matchAll(/\("([^"]+)",pid=(\d+),fd=(\d+)\)/g)].map((m) => ({ comm: m[1], pid: Number(m[2]), fd: Number(m[3]) })) });
  }
  return sockets;
};
const progName = (pid, comm) => {
  const argv = (read(`/proc/${pid}/cmdline`) || '').split('\0').filter(Boolean);
  const base = (w) => (w || '').split('/').pop();
  if (/^(node|bun|deno|python\d?(\.\d+)?)$/.test(base(argv[0])) && argv[1] && !argv[1].startsWith('-')) return base(argv[1]);
  return base(argv[0]) || comm;
};
const STALL_BYTES = 16384;
const spaces = new Map();
for (const line of run('sh', ['-c', `docker ps -q | xargs -r docker inspect -f '{{.State.Pid}} {{.Name}}'`]).split('\n')) {
  const [pid, name] = line.trim().split(' ');
  let ns = null;
  try { ns = fs.readlinkSync(`/proc/${pid}/ns/net`); } catch {}
  if (ns && !spaces.has(ns)) spaces.set(ns, { pid, container: (name || '').replace(/^\//, '') });
}
const queued = [...spaces.values()].map((n) => ({ ...n, sockets: new Map([...socketTable(n.pid)].filter(([, s]) => s.recvQ >= STALL_BYTES && s.users.length)) })).filter((n) => n.sockets.size);
const stalls = [];
if (queued.length) {
  await new Promise((resolve) => setTimeout(resolve, 2000));
  for (const n of queued) {
    const now = socketTable(n.pid);
    for (const inode of n.sockets.keys()) {
      const s = now.get(inode);
      const peer = s && now.get(s.peer);
      const reader = s?.users[0];
      const writer = reader && (peer?.users || []).find((u) => u.pid !== reader.pid);
      if (!s || s.recvQ < STALL_BYTES || !writer || !(peer.sendQ > 0)) continue;
      const stat = read(`/proc/${reader.pid}/stat`) || '';
      const f = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      const elapsed = uptime - Number(f[19]) / HZ;
      stalls.push({
        container: n.container, task: describe(n.container), unread: s.recvQ, writerQueued: peer.sendQ,
        reader: { pid: reader.pid, comm: progName(reader.pid, reader.comm), fd: reader.fd, averagePercent: elapsed > 0 ? Math.round(((Number(f[11]) + Number(f[12])) / HZ / elapsed) * 100) : null, elapsedMinutes: Math.round(elapsed / 60) },
        writer: { pid: writer.pid, comm: progName(writer.pid, writer.comm), wchan: (read(`/proc/${writer.pid}/wchan`) || '').trim() || null },
      });
    }
  }
}

const [load1, load5, load15] = os.loadavg().map((l) => Math.round(l * 100) / 100);
console.log('AF_JSON:' + JSON.stringify({
  cpus: os.cpus().length,
  load1,
  load5,
  load15,
  sampleSeconds: Math.round(seconds),
  busyPercent,
  busyCores: Math.round((busyPercent / 100) * os.cpus().length * 10) / 10,
  iowaitPercent,
  waitingPercent: Number.isFinite(pressure) ? Math.round(pressure) : null,
  top: procs.slice(0, PARAMS.top || 5),
  // Cores per container or service, exited processes included; the task URL
  // names who a task container works for.
  containers: cgroups.map((c) => ({ ...c, task: c.container ? describe(c.name) : null })),
  hogs,
  stalls,
}));
