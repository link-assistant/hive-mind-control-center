// Runs on the host as root (host Node.js) via `auto-fix.mjs --diagnose`, which
// prepends `const PARAMS = { seconds: 15, top: 8, hogPercent: 90, hogMinutes: 30 };`.
// Read-only: who uses the machine right now, and on whose behalf. It changes
// nothing (no process accounting, no tracing, no docker exec, nothing written
// except its own output), and every Docker call is bounded by a timeout and
// made before the sample window, so the docker CLI does not count in it.
//
// Lessons of 2026-10-20 built in:
// - CPU per container comes from cgroup v2 cpu.stat, which includes processes
//   that started and exited inside the window (the docker CLI calls of
//   start-command's monitor loops); a sum over live processes misses them.
// - Inside a container, each process gets its own CPU and the CPU of its
//   children that finished in the window (cutime), so short-lived work is
//   charged to the process that started it. New processes are also counted
//   by parent and command while the window runs (who forks what, how often).
// - Host busy cores come from /proc/stat, not the load average (which counts
//   I/O-waiting and bursty threads, hive-mind#3582); the cgroups must add up
//   to it, and the rest is shown as kernel/unaccounted.
// - This diagnosis's own CPU is measured and named, not mixed into the SSH
//   sessions line.
// - Command lines are cut at the first newline and redacted: the bot's
//   `--configuration` is multi-line and holds the Telegram token.
// - A task container is named by its solve URL, tool, model, start-command
//   execution and the Telegram user who requested it; the Formal AI sidecar
//   by the task containers connected to it.
// Lessons of 2026-10-24 built in:
// - CPU state of every container, the ones a task's own Docker daemon runs
//   inside it too: user/system split, time its threads waited for a CPU
//   (cgroup cpu.pressure), throttling against its CPU limit, process states.
// - A busy process is sampled again after the window: which thread burns the
//   CPU, whether it makes any system call at all (none: a loop in its own
//   code), and whether a program writing to it is blocked because it stopped
//   reading (`ss` in its network namespace: unread bytes on its sockets and
//   the writer's queue). A solve stuck like that stalls its AI session.
// - Blocked output is looked for in every container, not only behind a busy
//   process: a writer blocked on a full socket uses no CPU, and its reader
//   can be quiet in the window too. Lifetime CPU per process shows what is
//   busy only part of the time; the summary on top says it all in plain words.
// Prints one AF_JSON line: { report: [lines], ...data }.
import fs from 'node:fs';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

const HZ = 100; // USER_HZ
const PAGE = 4096;
const SECONDS = PARAMS.seconds || 15;
const TOP = PARAMS.top || 8;
const CG = '/sys/fs/cgroup';
const CPUS = os.cpus().length;
const selfStart = process.cpuUsage();

const run = (cmd, args, timeout = 20000) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout, maxBuffer: 64 * 1024 * 1024 });
  return r.status === 0 ? (r.stdout || '') : '';
};
// Bounded read: /proc files and cgroup files are small; a log header is the first KB.
const read = (file, max = 65536) => {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(max);
    const n = fs.readSync(fd, buf, 0, max, 0);
    return buf.toString('utf8', 0, n);
  } catch {
    return null;
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch {}
  }
};
const redact = (text) => text
  .replace(/--configuration\b.*/s, '--configuration [redacted]')
  .replace(/\b(gh[pousr]_|github_pat_)[A-Za-z0-9_]+/g, '$1***')
  .replace(/\bsk-[A-Za-z0-9_-]{16,}/g, 'sk-***')
  .replace(/\b\d{6,}:[A-Za-z0-9_-]{30,}\b/g, '***:***')
  .replace(/((?:token|password|passwd|secret|api[_-]?key)[=: ]+)\S+/gi, '$1***');
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;
const round = (n, d = 2) => Math.round(n * 10 ** d) / 10 ** d;
const mb = (bytes) => Math.round(bytes / 1048576);
const gb = (bytes) => round(bytes / 1073741824, 1);
const dur = (s) => (s >= 86400 ? `${Math.floor(s / 86400)}d${Math.floor((s % 86400) / 3600)}h` : s >= 3600 ? `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m` : `${Math.floor(s / 60)}m${String(Math.floor(s % 60)).padStart(2, '0')}s`);
const bootTime = Date.now() / 1000 - Number(read('/proc/uptime').split(' ')[0]);
const iso = (startTicks) => new Date((bootTime + startTicks / HZ) * 1000).toISOString().replace(/\.\d+Z$/, 'Z');

// ---- Docker facts, gathered before the window ----
const containers = new Map(); // full id -> facts
const runningIds = run('docker', ['ps', '--no-trunc', '-q']).split('\n').filter(Boolean);
const inspected = runningIds.length ? run('docker', ['inspect', '-f', '{{.Id}}\t{{.Name}}\t{{.State.Pid}}\t{{.State.StartedAt}}\t{{json .Config.Cmd}}\t{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}\t{{.HostConfig.NanoCpus}}\t{{.HostConfig.Memory}}', ...runningIds]) : '';
for (const line of inspected.split('\n').filter(Boolean)) {
  const [id, name, pid, startedAt, cmdJson, ips, nanoCpus, memory] = line.split('\t');
  let cmd = [];
  try { cmd = JSON.parse(cmdJson) || []; } catch {}
  const text = cmd.join(' ');
  const url = /'solve' '([^']+)'/.exec(text)?.[1] || (cmd[0] === 'solve' ? cmd[1] : null) || /\bsolve\s+(https:\/\/\S+)/.exec(text)?.[1] || null;
  const opt = (o) => new RegExp(`'--${o}' '([^']+)'`).exec(text)?.[1] || new RegExp(`--${o}\\s+(\\S+)`).exec(text)?.[1] || null;
  const n = name.replace(/^\//, '');
  containers.set(id, {
    id, name: n, initPid: Number(pid), startedAt: startedAt.replace(/\.\d+Z$/, 'Z'), ips: ips.trim().split(' ').filter(Boolean),
    cpuLimit: Number(nanoCpus) ? Number(nanoCpus) / 1e9 : null, memoryLimit: Number(memory) || null,
    role: n === 'hive-mind' ? 'root' : /formal-ai/.test(n) ? 'formal-ai' : url ? 'task' : 'container',
    url, tool: url ? opt('tool') : null, model: url ? opt('model') : null,
  });
}
const byName = new Map([...containers.values()].map((c) => [c.name, c]));
const byIp = new Map([...containers.values()].flatMap((c) => c.ips.map((ip) => [ip, c])));
const root = byName.get('hive-mind');

// start-command execution of each task (session = container name), from the
// log headers in the bot container, and who requested each URL (bot log).
if (root?.initPid) {
  const dir = `/proc/${root.initPid}/root/tmp/start-command/logs/isolation/docker`;
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.log')); } catch {}
  for (const f of files) {
    const head = read(`${dir}/${f}`, 1500) || '';
    const session = /^Session: (\S+)/m.exec(head)?.[1];
    const c = session && byName.get(session);
    if (c) c.execution = /^Execution ID: (\S+)/m.exec(head)?.[1] || f.replace(/\.log$/, '');
  }
  const tasks = [...containers.values()].filter((c) => c.url);
  if (tasks.length) {
    const lines = run('sh', ['-c', `docker logs --since 168h ${root.name} 2>&1 | grep -aoE 'Requested by: \\[@[A-Za-z0-9_]+\\][^"]{0,60}: https://github\\.com/[^ "\\\\]+' | tail -2000`], 25000).split('\n');
    for (const l of lines) {
      const m = /Requested by: \[@([A-Za-z0-9_]+)\].*?(https:\/\/github\.com\/[^ "\\]+)/.exec(l);
      if (!m) continue;
      for (const t of tasks) if (t.url === m[2]) t.requestedBy = '@' + m[1];
    }
  }
}

// ---- Snapshots ----
const procStat = (pid) => {
  const s = read(`/proc/${pid}/stat`, 2048);
  if (!s) return null;
  const close = s.lastIndexOf(')');
  const f = s.slice(close + 2).split(' ');
  return {
    pid: Number(pid), comm: s.slice(s.indexOf('(') + 1, close), state: f[0], ppid: Number(f[1]),
    own: Number(f[11]) + Number(f[12]), kids: Number(f[13]) + Number(f[14]),
    threads: Number(f[17]), start: Number(f[19]), rss: Number(f[21]) * PAGE,
  };
};
const cgroupPath = (pid) => /^0::(\S*)/m.exec(read(`/proc/${pid}/cgroup`, 4096) || '')?.[1];
const groupOfPath = (path) => {
  if (path === undefined) return '?';
  if (path === '/' || path === '') return 'kernel';
  const parts = path.split('/').filter(Boolean);
  return parts[0] === 'system.slice' ? `system.slice/${parts[1]}` : parts[0];
};
const cgroupOf = (pid) => groupOfPath(cgroupPath(pid));
const cmdlineOf = (pid, state) => {
  if (state === 'D' || state === 'Z') return '';
  // First line only: the bot's configuration follows a newline.
  return (read(`/proc/${pid}/cmdline`, 8192) || '').split('\n')[0].replace(/\0/g, ' ').trim();
};
const procs = () => {
  const map = new Map();
  for (const pid of fs.readdirSync('/proc')) if (/^\d+$/.test(pid)) {
    const p = procStat(pid);
    if (p) {
      const path = cgroupPath(pid);
      map.set(p.pid, { ...p, cg: groupOfPath(path), cgPath: (path || '').replace(/^\//, '') });
    }
  }
  return map;
};
const hostCpu = () => {
  const text = read('/proc/stat');
  const [user, nice, system, idle, iowait, irq, softirq, steal] = text.split('\n')[0].trim().split(/\s+/).slice(1).map(Number);
  const num = (k) => Number(new RegExp(`^${k} (\\d+)`, 'm').exec(text)?.[1] || 0);
  // Exact run time of all tasks per CPU (ns): /proc/stat's busy ticks miss
  // runs shorter than a tick on a tickless kernel, cgroup counters do not.
  const run = (read('/proc/schedstat') || '').split('\n').filter((l) => /^cpu\d/.test(l)).reduce((a, l) => a + Number(l.split(' ')[7] || 0), 0);
  return { user: user + nice, system, idle, iowait, irq: irq + softirq, steal, forks: num('processes'), ctxt: num('ctxt'), run, at: performance.now() };
};
const cgroupDirs = () => {
  const dirs = ['user.slice', 'init.scope'];
  try { for (const d of fs.readdirSync(`${CG}/system.slice`)) if (fs.existsSync(`${CG}/system.slice/${d}/cpu.stat`)) dirs.push(`system.slice/${d}`); } catch {}
  // Containers run by a task's own Docker daemon: <task scope>/docker/<id>.
  for (const d of dirs.filter((d) => /docker-[0-9a-f]{64}\.scope$/.test(d))) {
    try { for (const id of fs.readdirSync(`${CG}/${d}/docker`)) if (/^[0-9a-f]{64}$/.test(id)) dirs.push(`${d}/docker/${id}`); } catch {}
  }
  return dirs;
};
const cgroupStat = (dir) => {
  const kv = (file) => Object.fromEntries((read(`${CG}/${dir}/${file}`) || '').split('\n').filter(Boolean).map((l) => l.split(' ')).map(([k, v]) => [k, Number(v)]));
  const io = (read(`${CG}/${dir}/io.stat`) || '').split('\n').reduce((a, l) => {
    a.r += Number(/rbytes=(\d+)/.exec(l)?.[1] || 0);
    a.w += Number(/wbytes=(\d+)/.exec(l)?.[1] || 0);
    return a;
  }, { r: 0, w: 0 });
  const num = (file) => { const v = (read(`${CG}/${dir}/${file}`) || '').trim(); return v === '' || v === 'max' ? null : Number(v); };
  const cpu = kv('cpu.stat');
  const pressure = (read(`${CG}/${dir}/cpu.pressure`) || '');
  const [quota, period] = (read(`${CG}/${dir}/cpu.max`) || 'max').trim().split(' ');
  return {
    cpu: cpu.usage_usec || 0, user: cpu.user_usec || 0, system: cpu.system_usec || 0, throttled: cpu.nr_throttled || 0, throttledUsec: cpu.throttled_usec || 0,
    waitUsec: Number(/^some .*total=(\d+)/m.exec(pressure)?.[1] ?? NaN), cpuLimit: quota === 'max' ? null : Number(quota) / Number(period || 100000),
    memory: num('memory.current'), peak: num('memory.peak'), max: num('memory.max'), oomKills: kv('memory.events').oom_kill || 0, pids: num('pids.current'), pidsMax: num('pids.max'), io,
  };
};
const cgroups = () => { const m = new Map(cgroupDirs().map((d) => [d, cgroupStat(d)])); m.at = performance.now(); return m; };
const disks = () => (read('/proc/diskstats') || '').split('\n').map((l) => l.trim().split(/\s+/)).filter((f) => /^(sd[a-z]+|vd[a-z]+|xvd[a-z]+|nvme\d+n\d+)$/.test(f[2] || ''))
  .reduce((a, f) => ({ r: a.r + Number(f[5]) * 512, w: a.w + Number(f[9]) * 512 }), { r: 0, w: 0 });
const net = () => (read('/proc/net/dev') || '').split('\n').slice(2).map((l) => l.trim().split(/[:\s]+/)).filter((f) => f[0] && !/^(lo|docker|veth|br-)/.test(f[0]))
  .reduce((a, f) => ({ rx: a.rx + Number(f[1]), tx: a.tx + Number(f[9]) }), { rx: 0, tx: 0 });
const psi = (kind) => {
  const t = read(`/proc/pressure/${kind}`) || '';
  return { some: Number(/^some .*avg60=([\d.]+)/m.exec(t)?.[1] ?? NaN), full: Number(/^full .*avg60=([\d.]+)/m.exec(t)?.[1] ?? NaN) };
};

const windowStart = new Date().toISOString();
const p0 = procs();
const h0 = hostCpu();
const c0 = cgroups();
const d0 = disks();
const n0 = net();
const t0 = Date.now();
const self0 = process.cpuUsage();

// While the window runs: every new process, once, with its parent and command.
const seen = new Set([...p0.values()].map((p) => `${p.pid}:${p.start}`));
const spawned = [];
const scan = () => {
  for (const pid of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(pid)) continue;
    const p = procStat(pid);
    if (!p || seen.has(`${p.pid}:${p.start}`)) continue;
    seen.add(`${p.pid}:${p.start}`);
    spawned.push({ pid: p.pid, ppid: p.ppid, comm: p.comm, cmd: cmdlineOf(pid, p.state), cg: cgroupOf(pid) });
  }
};
while (Date.now() - t0 < SECONDS * 1000) {
  scan();
  await new Promise((resolve) => setTimeout(resolve, 100));
}

const p1 = procs();
const h1 = hostCpu();
const c1 = cgroups();
const d1 = disks();
const n1 = net();
const seconds = (Date.now() - t0) / 1000;
const selfCores = (() => { const u = process.cpuUsage(self0); return (u.user + u.system) / 1e6 / seconds; })();
const selfTotal = (() => { const u = process.cpuUsage(selfStart); return round((u.user + u.system) / 1e6, 1); })();

// ---- Host ----
const dt = (k) => h1[k] - h0[k];
const all = ['user', 'system', 'idle', 'iowait', 'irq', 'steal'].reduce((s, k) => s + dt(k), 0) || 1;
const busy = dt('user') + dt('system') + dt('irq') + dt('steal');
const meminfo = Object.fromEntries((read('/proc/meminfo') || '').split('\n').filter(Boolean).map((l) => { const [k, v] = l.split(':'); return [k, Number(v.trim().split(' ')[0]) * 1024]; }));
let disk = null;
try { const s = fs.statfsSync('/'); disk = { total: s.blocks * s.bsize, free: s.bavail * s.bsize }; } catch {}
const [load1, load5, load15] = os.loadavg().map((l) => round(l));
const states = [...p1.values()].reduce((a, p) => { a[p.state] = (a[p.state] || 0) + 1; return a; }, {});
const hostSeconds = (h1.at - h0.at) / 1000;
const cgroupSeconds = (c1.at - c0.at) / 1000;
// Machine total: exact task run time plus interrupt time (tick-sampled).
const busyCores = h1.run > h0.run ? (h1.run - h0.run) / 1e9 / hostSeconds + (dt('irq') / all) * CPUS : (busy / all) * CPUS;
const host = {
  cpus: CPUS, seconds: round(seconds, 1), windowStart, windowEnd: new Date().toISOString(),
  busyCores: round(busyCores), busyPercent: Math.round((busyCores / CPUS) * 100), tickBusyCores: round((busy / all) * CPUS),
  userCores: round((dt('user') / all) * CPUS), systemCores: round((dt('system') / all) * CPUS), irqCores: round((dt('irq') / all) * CPUS),
  iowaitPercent: Math.round((dt('iowait') / all) * 100), stealPercent: Math.round((dt('steal') / all) * 100),
  cpuWaitPercent: psi('cpu').some, memoryWaitPercent: psi('memory').some, ioWaitStallPercent: psi('io').some,
  load: [load1, load5, load15], forksPerSecond: Math.round(dt('forks') / seconds), contextSwitchesPerSecond: Math.round(dt('ctxt') / seconds),
  processes: p1.size, zombies: states.Z || 0, uninterruptible: states.D || 0, running: states.R || 0,
  memory: { total: meminfo.MemTotal, available: meminfo.MemAvailable, swapUsed: (meminfo.SwapTotal || 0) - (meminfo.SwapFree || 0) },
  disk, diskIo: { readMBs: round(mb(d1.r - d0.r) / seconds, 1), writeMBs: round(mb(d1.w - d0.w) / seconds, 1) },
  net: { rxMBs: round((n1.rx - n0.rx) / 1048576 / seconds, 2), txMBs: round((n1.tx - n0.tx) / 1048576 / seconds, 2) },
  diagnosisCores: round(selfCores), diagnosisCpuSeconds: selfTotal,
};

// ---- cgroups (containers and services) ----
const serviceLabel = {
  'system.slice/docker.service': 'dockerd',
  'system.slice/containerd.service': 'containerd (and container shims)',
  'system.slice/ssh.service': 'sshd (incl. failed logins)',
  'user.slice': 'SSH sessions',
  'init.scope': 'systemd',
  kernel: 'kernel threads',
};
// CPU state of a cgroup over the window: cores, user/system split, the share of
// the window in which at least one of its threads was runnable but waited for a
// CPU (cpu.pressure), throttling against its CPU limit.
const cpuState = (a, b) => ({
  cores: round((b.cpu - a.cpu) / 1e6 / cgroupSeconds), userCores: round((b.user - a.user) / 1e6 / cgroupSeconds), systemCores: round((b.system - a.system) / 1e6 / cgroupSeconds),
  cpuWaitPercent: Number.isFinite(b.waitUsec - a.waitUsec) ? Math.round(((b.waitUsec - a.waitUsec) / 1e6 / cgroupSeconds) * 100) : null,
  throttled: b.throttled - a.throttled, throttledSeconds: round((b.throttledUsec - a.throttledUsec) / 1e6, 1), cpuLimit: b.cpuLimit,
});
const groups = [];
const nestedDirs = [];
for (const [dir, b] of c1) {
  const a = c0.get(dir);
  if (!a) continue;
  if (/\/docker\/[0-9a-f]{64}$/.test(dir)) { nestedDirs.push(dir); continue; }
  const id = /docker-([0-9a-f]{64})\.scope$/.exec(dir)?.[1];
  const c = id ? containers.get(id) : null;
  groups.push({
    key: dir, container: c?.name || (id ? id.slice(0, 12) : null), role: c?.role || (id ? 'container' : 'service'),
    name: c?.name || serviceLabel[dir] || dir.replace(/^system\.slice\//, ''),
    ...cpuState(a, b), memory: b.memory, memoryPeak: b.peak, memoryLimit: b.max, oomKills: b.oomKills, pids: b.pids, pidsMax: b.pidsMax,
    readMBs: round(mb(b.io.r - a.io.r) / seconds, 1), writeMBs: round(mb(b.io.w - a.io.w) / seconds, 1),
    facts: c || null,
  });
}
groups.sort((x, y) => y.cores - x.cores);
const cgroupCores = round(groups.reduce((s, g) => s + g.cores, 0));

// ---- Processes ----
const cmdCache = new Map();
const cmdOf = (p) => {
  const k = `${p.pid}:${p.start}`;
  if (!cmdCache.has(k)) cmdCache.set(k, cmdlineOf(p.pid, p.state));
  return cmdCache.get(k);
};
const cgCache = new Map();
const cgOf = (p) => {
  if (!cgCache.has(p.pid)) cgCache.set(p.pid, p.cg || cgroupOf(p.pid));
  return cgCache.get(p.pid);
};
const sessionIn = (text) => {
  const m = UUID.exec(text);
  return m && byName.has(m[0]) ? m[0] : null;
};
// What a process is, from its command (full first line, before truncation).
const tagOf = (p) => {
  const cmd = cmdOf(p);
  if (/__start_command_cgroup_dir/.test(cmd)) return `start-command monitor loop for ${sessionIn(cmd) || '?'}`;
  if (/^docker logs -f /.test(cmd)) return `start-command log follower for ${sessionIn(cmd) || '?'}`;
  if (/hive-telegram-bot/.test(cmd)) return 'Telegram bot';
  if (/formal-ai serve/.test(cmd)) return 'Formal AI server';
  if (/^(dockerd|\/usr\/bin\/dockerd)\b/.test(cmd) && p.ppid !== 1) return 'dockerd (inside container)';
  const shim = /containerd-shim\S* .*-id ([0-9a-f]{64})/.exec(cmd)?.[1];
  if (shim) return `shim of ${containers.get(shim)?.name || shim.slice(0, 12)}`;
  return null;
};
const containerOfGroup = (cg) => {
  const id = /docker-([0-9a-f]{64})\.scope$/.exec(cg)?.[1];
  return id ? containers.get(id) : null;
};
// How a process came to be: its parents up to where it entered its cgroup.
const originOf = (p) => {
  const cg = cgOf(p);
  const chain = [];
  let cur = p;
  for (let i = 0; i < 30; i++) {
    const parent = p1.get(cur.ppid);
    if (!parent) { chain.push(cur.ppid === 0 ? 'kernel' : `pid ${cur.ppid} (gone)`); break; }
    if (cgOf(parent) !== cg) {
      const c = containerOfGroup(cg);
      if (/^containerd-shim/.test(parent.comm)) chain.push(c && c.initPid === cur.pid ? `container init (docker run of ${c.name})` : 'docker exec');
      else chain.push(`${parent.comm}(${parent.pid}) in ${cgOf(parent)}`);
      break;
    }
    chain.push(`${parent.comm}(${parent.pid})`);
    cur = parent;
  }
  return chain.join(' < ');
};
const tagWithAncestors = (p) => {
  const cg = cgOf(p);
  for (let cur = p, i = 0; cur && i < 30 && cgOf(cur) === cg; cur = p1.get(cur.ppid), i++) {
    const t = tagOf(cur);
    if (t) return t;
  }
  return null;
};

// The nearest ancestor of a new process that is known: a tagged or
// long-lived process, walking through parents that were themselves short-lived.
const spawnedByPid = new Map(spawned.map((s) => [s.pid, s]));
const ancestorLabel = (ppid, cg) => {
  let via = null;
  for (let pid = ppid, i = 0; i < 20; i++) {
    const p = p1.get(pid) || p0.get(pid);
    if (p) {
      // A shim starts runc in its own cgroup; in a container's cgroup its child came from docker exec.
      if (/^containerd-shim/.test(p.comm)) return cgOf(p) === cg ? (tagOf(p) || p.comm) : `docker exec${tagOf(p) ? ` (via ${tagOf(p)})` : ''}`;
      const inherited = cgOf(p) === cg ? tagWithAncestors(p) : null;
      const label = tagOf(p) || (inherited ? `${inherited} via ${shape(cmdOf(p), p.comm)}` : `${p.comm}(${p.pid})`);
      return via ? `${label} via short-lived ${via}` : label;
    }
    const s = spawnedByPid.get(pid);
    if (!s) return via ? `exited parent (via ${via})` : 'exited parent';
    via = via || s.comm;
    if (/__start_command_cgroup_dir/.test(s.cmd)) return `start-command monitor loop for ${sessionIn(s.cmd) || '?'}`;
    pid = s.ppid;
  }
  return 'unknown';
};

// A child that was alive at the start and was reaped in the window adds its
// whole life's CPU to its parent's children counter: take off what it had
// used before the window, or a long test that ends in the window is counted
// in full. Processes gone without a parent left to count them are listed.
const before = new Map();
const exited = [];
for (const [pid, a] of p0) {
  const b = p1.get(pid);
  if (b && b.start === a.start) continue;
  const parent = p1.get(a.ppid);
  if (parent && p0.get(a.ppid)?.start === parent.start) before.set(a.ppid, (before.get(a.ppid) || 0) + a.own + a.kids);
  exited.push(a);
}
const rows = [];
for (const [pid, b] of p1) {
  const a = p0.get(pid);
  const fresh = !a || a.start !== b.start;
  const own = (b.own - (fresh ? 0 : a.own)) / HZ / seconds;
  const kids = Math.max(0, b.kids - (fresh ? 0 : a.kids) - (fresh ? 0 : before.get(pid) || 0)) / HZ / seconds;
  const elapsed = Date.now() / 1000 - (bootTime + b.start / HZ);
  rows.push({ p: b, own, kids, total: own + kids, elapsed, average: elapsed > 0 ? b.own / HZ / elapsed : 0 });
}
const procView = (r) => ({
  pid: r.p.pid, ppid: r.p.ppid, comm: r.p.comm, state: r.p.state,
  command: redact(cmdOf(r.p)).slice(0, 180) || `[${r.p.comm}]`,
  started: iso(r.p.start), age: dur(r.elapsed),
  cores: round(r.total), ownCores: round(r.own), childCores: round(r.kids), averagePercent: Math.round(r.average * 100),
  cpuMinutes: Math.round(r.p.own / HZ / 60), cpuSeconds: Math.round(r.p.own / HZ), rssMB: mb(r.p.rss), threads: r.p.threads,
  what: tagOf(r.p) || (tagWithAncestors(r.p) ? `started by ${tagWithAncestors(r.p)}` : null), origin: originOf(r.p),
});
const shape = (cmd, comm) => {
  if (/__start_command_cgroup_dir/.test(cmd || '')) return 'sh -c __start_command_cgroup_dir… (start-command monitor check)';
  const words = redact(cmd || `[${comm}]`).replace(new RegExp(UUID.source, 'g'), '<session>').split(/\s+/).slice(0, 4).join(' ');
  return words.length > 70 ? words.slice(0, 70) + '…' : words;
};

for (const g of groups) {
  const mine = rows.filter((r) => cgOf(r.p) === g.key);
  g.processes = mine.length;
  g.zombies = mine.filter((r) => r.p.state === 'Z').length;
  g.top = mine.filter((r) => r.total >= 0.01).sort((x, y) => y.total - x.total).slice(0, TOP).map(procView);
  // Charge each process (own + its finished children) to the nearest tagged ancestor.
  const by = {};
  for (const r of mine) {
    if (r.total <= 0) continue;
    const t = tagWithAncestors(r.p) || (g.role === 'task' ? 'task processes' : g.role === 'root' ? 'other processes' : 'processes');
    by[t] = (by[t] || 0) + r.total;
  }
  const botRow = mine.find((r) => tagOf(r.p) === 'Telegram bot');
  if (botRow && by['Telegram bot'] !== undefined) {
    // Split the bot: its own code vs the commands it runs (finished ones are
    // in its children's CPU, running ones are its descendants).
    by['Telegram bot: commands it runs (docker stats, $ --status, $ --list, ...)'] = by['Telegram bot'] - botRow.own;
    by['Telegram bot: its own code'] = botRow.own;
    delete by['Telegram bot'];
  }
  const attributed = Object.values(by).reduce((s, v) => s + v, 0);
  // The rest ran in processes that ended in the window and whose parent did
  // not count them: started by docker exec from outside, or by a parent that
  // ended too.
  const gone = exited.filter((p) => p.cg === g.key);
  const goneNames = Object.entries(gone.reduce((a, p) => { a[p.comm] = (a[p.comm] || 0) + 1; return a; }, {})).sort((x, y) => y[1] - x[1]).slice(0, 4).map(([c, n]) => `${c} ×${n}`);
  if (g.cores - attributed >= 0.03) by[`processes that ended in the window, not counted by a parent (${[g.role === 'service' ? null : 'docker exec', gone.length ? `running at the start: ${goneNames.join(', ')}` : null].filter(Boolean).join('; ') || 'started and ended between scans'})`] = g.cores - attributed;
  g.breakdown = Object.entries(by).map(([what, cores]) => ({ what, cores: round(cores) })).filter((b) => b.cores >= 0.01).sort((x, y) => y.cores - x.cores);
  // Who spawned what in the window.
  const spawns = {};
  for (const s of spawned.filter((s) => s.cg === g.key)) {
    const k = `${ancestorLabel(s.ppid, g.key)} → ${shape(s.cmd, s.comm)}`;
    spawns[k] = (spawns[k] || 0) + 1;
  }
  g.spawned = Object.values(spawns).reduce((s, n) => s + n, 0);
  g.spawns = Object.entries(spawns).sort((x, y) => y[1] - x[1]).slice(0, TOP + 4).map(([what, n]) => ({ what, perMinute: Math.round((n / seconds) * 60) }));
  // Zombies by the parent that does not reap them.
  const z = {};
  for (const r of mine.filter((r) => r.p.state === 'Z')) {
    const parent = p1.get(r.p.ppid);
    const init = parent && g.facts?.initPid === parent.pid;
    const k = parent ? `${parent.comm}(${parent.pid})${init ? ', the container\'s PID 1, which does not reap orphaned processes (no --init)' : tagOf(parent) ? ' ' + tagOf(parent) : ''}` : `pid ${r.p.ppid}`;
    z[k] = (z[k] || 0) + 1;
  }
  g.zombieParents = Object.entries(z).sort((x, y) => y[1] - x[1]).slice(0, 3).map(([parent, count]) => ({ parent, count }));
}

// Process states per container (R running or runnable, D waiting on I/O, Z zombies).
const statesOf = (list) => list.reduce((a, r) => { a[r.p.state] = (a[r.p.state] || 0) + 1; return a; }, {});
for (const g of groups) g.states = statesOf(rows.filter((r) => cgOf(r.p) === g.key));
// Containers a task's own Docker daemon runs (part of the task's numbers above).
const nested = nestedDirs.map((dir) => {
  const mine = rows.filter((r) => r.p.cgPath === dir);
  const first = mine.slice().sort((x, y) => x.p.start - y.p.start)[0];
  const parent = groups.find((g) => g.key === groupOfPath('/' + dir));
  return {
    key: dir, id: dir.slice(-64, -52), parent: parent?.name || groupOfPath('/' + dir), ...cpuState(c0.get(dir), c1.get(dir)),
    memory: c1.get(dir).memory, processes: mine.length, states: statesOf(mine),
    main: first ? shape(cmdOf(first.p), first.p.comm) : null,
    top: mine.filter((r) => r.total >= 0.01).sort((x, y) => y.total - x.total).slice(0, 3).map((r) => ({ pid: r.p.pid, cores: round(r.total), command: shape(cmdOf(r.p), r.p.comm) })),
  };
});

// Kernel threads have no cgroup line of their own: show them as one group.
const kernelRows = rows.filter((r) => cgOf(r.p) === 'kernel');
const kernelCores = round(kernelRows.reduce((s, r) => s + r.own, 0));

// Formal AI: which task containers are connected (inbound, established).
const hexIp = (hex) => hex.match(/../g).reverse().map((h) => parseInt(h, 16)).join('.');
for (const g of groups.filter((g) => g.role === 'formal-ai' && g.facts?.initPid)) {
  const sockets = (read(`/proc/${g.facts.initPid}/net/tcp`, 1 << 20) || '').split('\n').slice(1).map((l) => l.trim().split(/\s+/)).filter((f) => f.length > 3);
  const listening = new Set(sockets.filter((f) => f[3] === '0A').map((f) => f[1].split(':')[1]));
  const clients = new Set();
  for (const [, local, remote, state] of sockets) if (state === '01' && listening.has(local.split(':')[1])) clients.add(hexIp(remote.split(':')[0]));
  g.clients = [...clients].map((ip) => byIp.get(ip)?.name || ip);
}

// Long busy processes: a whole core now, most of a long life (busy loop?).
const hogs = rows.filter((r) => r.own * 100 >= (PARAMS.hogPercent ?? 90) && r.average >= 0.8 && r.elapsed >= (PARAMS.hogMinutes ?? 30) * 60).map((r) => ({ ...procView(r), group: cgOf(r.p) }));

// ---- Busy processes, sampled again after the window ----
// Which thread burns the CPU, whether the process makes system calls at all,
// and whether a program writing to it is blocked because it stopped reading.
const FOLLOW_SECONDS = 3;
const kvFile = (file) => Object.fromEntries((read(file) || '').split('\n').filter(Boolean).map((l) => l.split(/:\s*/)).map(([k, v]) => [k, Number(v)]));
const probe = (pid) => {
  const threads = new Map();
  let voluntary = 0;
  let involuntary = 0;
  try {
    for (const tid of fs.readdirSync(`/proc/${pid}/task`)) {
      const t = procStat(`${pid}/task/${tid}`);
      if (t) threads.set(tid, { comm: t.comm, ticks: t.own });
      const st = kvFile(`/proc/${pid}/task/${tid}/status`);
      voluntary += st.voluntary_ctxt_switches || 0;
      involuntary += st.nonvoluntary_ctxt_switches || 0;
    }
  } catch {}
  const io = kvFile(`/proc/${pid}/io`); // whole process, all threads
  return { threads, syscalls: (io.syscr || 0) + (io.syscw || 0), rchar: io.rchar || 0, wchar: io.wchar || 0, voluntary, involuntary, at: performance.now() };
};
// Every unix socket of a network namespace with its queues and owners (`ss`:
// queue sizes are not in /proc). Keyed by inode; `peer` is the other end.
const socketTable = (pid) => {
  const sockets = new Map();
  for (const line of run('nsenter', ['-t', String(pid), '-n', 'ss', '-xpH'], 8000).split('\n')) {
    const f = line.trim().split(/\s+/);
    if (f.length < 8) continue;
    const users = [...line.matchAll(/\("([^"]+)",pid=(\d+),fd=(\d+)\)/g)].map((m) => ({ comm: m[1], pid: Number(m[2]), fd: Number(m[3]) }));
    sockets.set(f[5], { recvQ: Number(f[2]), sendQ: Number(f[3]), peer: f[7], users });
  }
  return sockets;
};
const progName = (pid, comm) => {
  const argv = (read(`/proc/${pid}/cmdline`, 4096) || '').split('\0').filter(Boolean);
  const base = (w) => (w || '').split('/').pop();
  if (/^(node|bun|deno|python\d?(\.\d+)?)$/.test(base(argv[0])) && argv[1] && !argv[1].startsWith('-')) return base(argv[1]);
  return base(argv[0]) || comm;
};
const waitingOn = (pid) => ({ state: procStat(pid)?.state || null, wchan: (read(`/proc/${pid}/wchan`) || '').trim() || null });
// Unix sockets of the process with unread bytes, and the program on the other end.
const backlog = (pid) => {
  const fds = new Map();
  try {
    for (const fd of fs.readdirSync(`/proc/${pid}/fd`)) {
      const inode = /^socket:\[(\d+)\]$/.exec(fs.readlinkSync(`/proc/${pid}/fd/${fd}`))?.[1];
      if (inode) fds.set(inode, fd);
    }
  } catch {}
  if (!fds.size) return [];
  const sockets = socketTable(pid);
  const out = [];
  for (const [inode, fd] of fds) {
    const s = sockets.get(inode);
    if (!s || s.recvQ <= 0) continue;
    const peer = sockets.get(s.peer);
    const writers = (peer?.users || []).filter((u) => u.pid !== pid);
    const wpid = writers[0]?.pid;
    out.push({
      fd: Number(fd), unread: s.recvQ, writerQueued: peer?.sendQ ?? null,
      writer: wpid ? { pid: wpid, comm: writers[0].comm, fds: [...new Set(writers.filter((u) => u.pid === wpid).map((u) => u.fd))].sort((x, y) => x - y), ...waitingOn(wpid) } : null,
    });
  }
  return out.sort((x, y) => y.unread - x.unread);
};
// Half a core is enough: with the CPUs saturated a spinning process gets less than a whole one.
const busyRows = rows.filter((r) => r.own >= 0.5 && cgOf(r.p) !== 'kernel').sort((x, y) => y.own - x.own).slice(0, 5);
// Blocked output, looked for in every container, busy or not: a program whose
// output nobody reads waits without using any CPU, so CPU numbers alone miss it
// (2026-10-24: Claude waited for hours on a full socket while its solve was
// sometimes busy, sometimes not). One `ss` per network namespace, twice.
const STALL_BYTES = 16384;
const namespaces = new Map();
for (const g of groups.filter((g) => g.role !== 'service')) {
  const pid = g.facts?.initPid || rows.find((r) => cgOf(r.p) === g.key)?.p.pid;
  let ns = null;
  try { ns = fs.readlinkSync(`/proc/${pid}/ns/net`); } catch {}
  if (pid && ns && !namespaces.has(ns)) namespaces.set(ns, { pid, group: g.key });
}
const queuedIn = (sockets) => new Map([...sockets].filter(([, s]) => s.recvQ >= STALL_BYTES && s.users.length));
const stallFirst = [...namespaces.values()].map((n) => ({ ...n, queued: queuedIn(socketTable(n.pid)) })).filter((n) => n.queued.size);
const ioOf = (pid) => { const io = kvFile(`/proc/${pid}/io`); return { syscalls: (io.syscr || 0) + (io.syscw || 0), ticks: procStat(pid)?.own ?? null }; };
const stallIo = new Map(stallFirst.flatMap((n) => [...n.queued.values()].flatMap((s) => s.users.map((u) => [u.pid, ioOf(u.pid)]))));
const busyProcs = [];
const stalls = [];
const followFirst = busyRows.map((r) => probe(r.p.pid));
const followStart = performance.now();
if (busyRows.length || stallFirst.length) await new Promise((resolve) => setTimeout(resolve, FOLLOW_SECONDS * 1000));
const followSeconds = (performance.now() - followStart) / 1000;
for (const n of stallFirst) {
  const now = socketTable(n.pid);
  for (const [inode, a] of n.queued) {
    const b = now.get(inode);
    if (!b || b.recvQ < STALL_BYTES) continue; // read in the meantime
    const reader = b.users[0];
    const peer = now.get(b.peer);
    const writer = (peer?.users || []).find((u) => u.pid !== reader.pid);
    const io0 = stallIo.get(reader.pid);
    const io1 = ioOf(reader.pid);
    const r = rows.find((x) => x.p.pid === reader.pid);
    stalls.push({
      group: n.group, seconds: round(followSeconds, 1),
      reader: { pid: reader.pid, comm: progName(reader.pid, reader.comm), fd: reader.fd, command: r ? shape(cmdOf(r.p), r.p.comm) : reader.comm, ...waitingOn(reader.pid),
        cores: io0?.ticks != null && io1.ticks != null ? round((io1.ticks - io0.ticks) / HZ / followSeconds) : null,
        syscalls: io0 ? io1.syscalls - io0.syscalls : null,
        averagePercent: r ? Math.round(r.average * 100) : null, age: r ? dur(r.elapsed) : null, cpuMinutes: r ? Math.round(r.p.own / HZ / 60) : null },
      unreadBefore: a.recvQ, unread: b.recvQ,
      writer: writer ? { pid: writer.pid, comm: progName(writer.pid, writer.comm), fds: [...new Set(peer.users.filter((u) => u.pid === writer.pid).map((u) => u.fd))].sort((x, y) => x - y), queued: peer.sendQ, ...waitingOn(writer.pid) } : null,
    });
  }
}
if (busyRows.length) {
  const first = followFirst;
  busyRows.forEach((r, i) => {
    const a = first[i];
    const b = probe(r.p.pid);
    if (!b.threads.size) return; // ended
    const sec = (b.at - a.at) / 1000;
    const threads = [...b.threads].map(([tid, t]) => ({ tid: Number(tid), comm: t.comm, cores: round((t.ticks - (a.threads.get(tid)?.ticks ?? t.ticks)) / HZ / sec) })).filter((t) => t.cores >= 0.05).sort((x, y) => y.cores - x.cores);
    busyProcs.push({
      pid: r.p.pid, comm: r.p.comm, command: shape(cmdOf(r.p), r.p.comm), group: cgOf(r.p), seconds: round(sec, 1),
      cores: round(threads.reduce((s, t) => s + t.cores, 0)), threads,
      syscallsPerSecond: round((b.syscalls - a.syscalls) / sec, 1), readBytes: b.rchar - a.rchar, writtenBytes: b.wchar - a.wchar,
      voluntary: b.voluntary - a.voluntary, involuntary: b.involuntary - a.involuntary, hog: hogs.some((h) => h.pid === r.p.pid),
      inKernel: (read(`/proc/${r.p.pid}/syscall`, 256) || '').split(' ')[0].trim(),
      backlog: backlog(r.p.pid),
    });
  });
}

// Biggest CPU users since they started (10+ CPU minutes): a process that is
// busy only part of the time can be quiet in the window and still burn hours.
const heavy = rows.filter((r) => cgOf(r.p) !== 'kernel' && r.p.own / HZ >= 600).sort((x, y) => y.p.own - x.p.own).slice(0, 10)
  .map((r) => ({ pid: r.p.pid, comm: progName(r.p.pid, r.p.comm), command: shape(cmdOf(r.p), r.p.comm), group: cgOf(r.p), started: iso(r.p.start), age: dur(r.elapsed), ageSeconds: Math.round(r.elapsed), cpuSeconds: Math.round(r.p.own / HZ), averagePercent: Math.round(r.average * 100), cores: round(r.own) }));

// ---- Report ----
const L = [];
const pad = (v, n) => String(v).padStart(n);
const fmtMem = (b) => (b == null ? '-' : b >= 1073741824 ? `${gb(b)}G` : `${mb(b)}M`);
const taskLine = (f) => [f.url, f.tool && `--tool ${f.tool}`, f.model && `--model ${f.model}`].filter(Boolean).join(' ');
L.push(`MACHINE (${host.seconds}s window): ${host.busyCores}/${CPUS} cores busy (${host.busyPercent}%, scheduler run time + interrupts; tick-sampled split: user ${host.userCores}, system ${host.systemCores}, irq ${host.irqCores}), I/O wait ${host.iowaitPercent}%, steal ${host.stealPercent}%`);
L.push(`  tasks waiting for a CPU ${host.cpuWaitPercent}% of the time, for memory ${host.memoryWaitPercent}%, for I/O ${host.ioWaitStallPercent}% (PSI avg60); load average ${host.load.join(' / ')} (demand incl. I/O waits and short bursts, not CPU used)`);
L.push(`  memory ${gb(host.memory.total - host.memory.available)}/${gb(host.memory.total)}G used, swap ${gb(host.memory.swapUsed)}G; disk / ${disk ? `${gb(disk.total - disk.free)}/${gb(disk.total)}G used` : '?'}, I/O ${host.diskIo.readMBs} MB/s read, ${host.diskIo.writeMBs} MB/s write; network ${host.net.rxMBs} MB/s in, ${host.net.txMBs} MB/s out`);
L.push(`  ${host.processes} processes (${host.running} running, ${host.uninterruptible} in D state, ${host.zombies} zombies), ${host.forksPerSecond} new processes/s, ${host.contextSwitchesPerSecond} context switches/s`);
L.push('');
L.push('WHO USES IT (cores over the window; per cgroup, so processes that exited in the window are included):');
L.push(`  ${pad('cores', 5)} ${pad('memory', 7)} ${pad('IO MB/s', 9)}  who`);
const describe = (g) => {
  const f = g.facts;
  if (g.role === 'root') return `root container ${g.name}: Telegram bot, start-command monitors, task logs`;
  if (g.role === 'formal-ai') return `Formal AI sidecar ${g.name}${g.clients?.length ? `, serving ${g.clients.join(', ')}` : ', no client connected'}`;
  if (g.role === 'task') return `task ${g.name}: ${taskLine(f)}${f.requestedBy ? `, requested by ${f.requestedBy}` : ''}${f.execution ? `, execution ${f.execution}` : ''}, started ${f.startedAt}`;
  if (g.key === 'user.slice') return `SSH sessions (this diagnosis: ${host.diagnosisCores} cores)`;
  return g.name;
};
for (const g of groups.filter((g) => g.cores >= 0.01 || g.role !== 'service')) {
  L.push(`  ${pad(g.cores.toFixed(2), 5)} ${pad(fmtMem(g.memory), 7)} ${pad(`${g.readMBs}/${g.writeMBs}`, 9)}  ${describe(g)}`);
}
const unaccounted = round(host.busyCores - cgroupCores - kernelCores);
L.push(`  ${pad(kernelCores.toFixed(2), 5)} ${pad('', 7)} ${pad('', 9)}  kernel threads`);
L.push(unaccounted >= 0
  ? `  ${pad(unaccounted.toFixed(2), 5)} ${pad('', 7)} ${pad('', 9)}  interrupts and other kernel time (machine total minus the above)`
  : `  ${pad(unaccounted.toFixed(2), 5)} ${pad('', 7)} ${pad('', 9)}  counter difference: the machine and cgroup counters are read a few ms apart`);
L.push(`  ${pad(host.busyCores.toFixed(2), 5)} ${pad(fmtMem(host.memory.total - host.memory.available), 7)} ${pad('', 9)}  = machine total`);

L.push('');
L.push('CPU STATE PER CONTAINER (cores over the window; waited = share of the window in which at least one of its threads was ready to run but had no CPU; throttled = periods held back by its CPU limit):');
L.push(`  ${pad('cores', 5)} ${pad('user', 5)} ${pad('sys', 5)} ${pad('waited', 6)} ${pad('throttled', 9)} ${pad('limit', 6)} ${pad('procs', 5)} ${pad('R', 3)} ${pad('D', 3)} ${pad('Z', 5)}  container`);
const shortName = (g) => (g.role === 'task' ? `task ${g.name} (${g.facts?.url || '?'})` : g.role === 'root' ? `${g.name} (root: bot, start-command monitors)` : g.name);
const stateRow = (x, label, indent = '') => `  ${indent}${pad(x.cores.toFixed(2), 5 - indent.length)} ${pad(x.userCores.toFixed(2), 5)} ${pad(x.systemCores.toFixed(2), 5)} ${pad(x.cpuWaitPercent == null ? '?' : x.cpuWaitPercent + '%', 6)} ${pad(x.throttled ? `${x.throttled} (${x.throttledSeconds}s)` : '0', 9)} ${pad(x.cpuLimit ? round(x.cpuLimit, 1) : 'none', 6)} ${pad(x.processes ?? '', 5)} ${pad(x.states?.R || 0, 3)} ${pad(x.states?.D || 0, 3)} ${pad(x.states?.Z || 0, 5)}  ${label}`;
for (const g of groups.filter((g) => g.role !== 'service')) {
  L.push(stateRow(g, shortName(g) + (g.pidsMax && g.pids >= g.pidsMax * 0.8 ? ` — ${g.pids}/${g.pidsMax} PIDs used` : '')));
  for (const n of nested.filter((n) => n.parent === g.name)) L.push(stateRow(n, `inside it: container ${n.id}${n.main ? ` (${n.main})` : ''}`, '↳ '));
}

for (const g of groups.filter((g) => g.role !== 'service' && (g.cores >= 0.05 || g.role === 'root'))) {
  L.push('');
  L.push(`${describe(g)}: ${g.cores} cores, ${fmtMem(g.memory)} memory${g.memoryLimit ? ` of ${fmtMem(g.memoryLimit)}` : ''}${g.memoryPeak ? `, peak ${fmtMem(g.memoryPeak)}` : ''}, ${g.processes} processes${g.zombies ? ` (${g.zombies} zombies)` : ''}${g.oomKills ? `, ${g.oomKills} OOM kills` : ''}`);
  if (g.breakdown.length) {
    L.push('  by what it is (each process with the CPU of its finished children, charged to its nearest known ancestor):');
    for (const b of g.breakdown) L.push(`    ${pad(b.cores.toFixed(2), 5)}  ${b.what}`);
  }
  if (g.top.length) {
    L.push('  top processes (cores = own + finished children):');
    for (const p of g.top) {
      L.push(`    ${pad(p.cores.toFixed(2), 5)} (own ${p.ownCores}, children ${p.childCores})  pid ${p.pid}  ${p.command}`);
      L.push(`          ${p.what ? p.what + '; ' : ''}started ${p.started} (${p.age} ago), ${p.cpuMinutes} CPU min, lifetime avg ${p.averagePercent}%, ${p.rssMB} MB, ${p.threads} threads; from: ${p.origin}`);
    }
  }
  if (g.spawns.length) {
    L.push(`  started in the window (${Math.round((g.spawned / seconds) * 60)}/min):`);
    for (const s of g.spawns) L.push(`    ${pad(s.perMinute, 5)}/min  ${s.what}`);
  }
  for (const z of g.zombieParents) L.push(`  ${z.count} zombie(s) not reaped by ${z.parent}`);
}
const svcSpawns = groups.filter((g) => g.role === 'service' && g.spawns.length && g.spawned / seconds * 60 >= 30);
for (const g of svcSpawns) {
  L.push('');
  L.push(`${g.name}: started in the window (${Math.round((g.spawned / seconds) * 60)}/min): ${g.spawns.slice(0, 4).map((s) => `${s.what} ${s.perMinute}/min`).join('; ')}`);
}
if (hogs.length) {
  L.push('');
  for (const h of hogs) L.push(`WARNING: possible busy loop: pid ${h.pid} ${h.command} in ${groups.find((g) => g.key === h.group)?.name || h.group}: ${h.ownCores} cores now, ${h.averagePercent}% of a core on average for ${h.age} (${h.cpuMinutes} CPU min). Reported only, never stopped.`);
}
const kb = (n) => (n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`);
const fdName = (fd) => ({ 0: 'stdin', 1: 'stdout', 2: 'stderr' })[fd] || `fd ${fd}`;
if (busyProcs.length) {
  L.push('');
  L.push(`BUSY PROCESSES, sampled again for ${FOLLOW_SECONDS}s after the window (reported only, never stopped):`);
  for (const b of busyProcs) {
    const where = groups.find((g) => g.key === b.group)?.name || b.group;
    if (b.cores < 0.3) {
      L.push(`  pid ${b.pid} ${b.command} in ${where}: busy in the window, ${b.cores} cores now`);
      continue;
    }
    L.push(`  pid ${b.pid} ${b.command} in ${where}: ${b.cores} cores; ${b.threads.map((t) => `thread ${t.comm} (${t.tid}) ${t.cores}`).join(', ')}`);
    L.push(b.syscallsPerSecond === 0
      ? `    0 system calls in ${b.seconds}s (nothing read or written): ${b.hog ? 'a loop in its own code, not waiting for anything' : 'computing in its own code (normal for a compiler or a benchmark, not for a program that should wait for input)'}; context switches ${b.voluntary} voluntary / ${b.involuntary} forced`
      : `    ${b.syscallsPerSecond} system calls/s, ${kb(b.readBytes)} read, ${kb(b.writtenBytes)} written in ${b.seconds}s; context switches ${b.voluntary} voluntary / ${b.involuntary} forced`);
    for (const k of b.backlog.slice(0, 3)) {
      const w = k.writer;
      L.push(w
        ? `    not reading: ${kb(k.unread)} unread on its fd ${k.fd} from ${w.comm}(${w.pid}) ${w.fds.map(fdName).join('/')}, which has ${kb(k.writerQueued || 0)} more queued${w.state === 'S' && k.writerQueued ? ` and waits (${w.wchan || '?'}): it cannot write its output, so it is stalled too` : ''}`
        : `    not reading: ${kb(k.unread)} unread on its fd ${k.fd}`);
    }
  }
}
const groupName = (key) => {
  const g = groups.find((x) => x.key === key);
  if (!g) return key;
  return g.role === 'task' ? `task ${g.name.slice(0, 8)} (${(g.facts?.url || '?').replace(/^https:\/\/github\.com\//, '')})` : g.role === 'root' ? `${g.name} (Telegram bot)` : g.name;
};
if (stalls.length) {
  L.push('');
  L.push(`BLOCKED OUTPUT, looked for in every container (still unread after ${FOLLOW_SECONDS}s; reported only, never stopped):`);
  for (const x of stalls) {
    const r = x.reader;
    const w = x.writer;
    L.push(`  ${groupName(x.group)}: ${r.comm}(${r.pid}) has ${kb(x.unread)} unread on its fd ${r.fd}${w ? ` from ${w.comm}(${w.pid}) ${w.fds.map(fdName).join('/')}, which has ${kb(w.queued)} more queued${w.queued && w.state === 'S' ? ` and waits (${w.wchan || '?'}): it cannot write, so it is stalled` : ''}` : ''}`);
    L.push(r.syscalls === 0
      ? `    ${r.comm} read nothing in ${x.seconds}s and made no system call: ${r.cores != null && r.cores >= 0.3 ? `it is busy in its own code (${r.cores} cores)` : `it waits for something else (state ${r.state}, ${r.wchan || '?'})`}${r.age ? `; ${r.averagePercent}% of a core on average for ${r.age} (${r.cpuMinutes} CPU min)` : ''}`
      : `    ${r.comm} is reading (${r.syscalls} system calls, ${r.cores ?? '?'} cores in ${x.seconds}s) but has not caught up: unread ${kb(x.unreadBefore)} → ${kb(x.unread)}`);
  }
}
if (heavy.length) {
  L.push('');
  L.push('BIGGEST CPU USERS SINCE THEY STARTED (10+ CPU min; a process busy only part of the time can be quiet in the window):');
  for (const h of heavy) L.push(`  ${pad(Math.round(h.cpuSeconds / 60), 5)} CPU min in ${pad(h.age, 6)} = ${pad(h.averagePercent, 3)}% of a core on average, ${h.cores} now  pid ${h.pid} ${h.command}  (${groupName(h.group)})`);
}

// ---- In short, in plain words: what a person needs to know first ----
const S = [];
const isAi = (comm) => /^(claude|codex|opencode|gemini|qwen|agent)/i.test(comm || '');
S.push(`IN SHORT (plain words; details below):`);
S.push(`- CPU: the server has ${CPUS} cores. Over these ${Math.round(host.seconds)}s, ${round(host.busyCores, 1)} of them were working (${host.busyPercent}%) and ${round(Math.max(0, CPUS - host.busyCores), 1)} were free.`);
const w = host.cpuWaitPercent == null ? null : Math.round(host.cpuWaitPercent);
if (w != null) S.push(`- Waiting: in the last minute, ${w}% of the time some program was ready to run but had to wait for a free core. ${w < 5 ? 'That is almost never: there is enough CPU.' : w < 25 ? 'That happens in short moments when many programs want a core at once; it slows them down a little.' : 'That is often: there is not enough CPU for everything that runs, so tasks run slower.'}`);
const users = groups.filter((g) => g.cores >= 0.05 && g.key !== 'user.slice').slice(0, 4).map((g) => `${groupName(g.key)} ${g.cores}`);
S.push(`- Biggest users now (cores): ${users.join(', ') || 'nothing is busy'}.`);
const problems = [];
const mentioned = new Set();
// A problem only when the writer is blocked: its own queue is full too.
for (const x of stalls.filter((x) => x.writer?.queued > 0)) {
  const r = x.reader;
  const wr = x.writer;
  mentioned.add(r.pid);
  const who = isAi(wr.comm) ? `the AI session (${wr.comm}, pid ${wr.pid})` : `${wr.comm} (pid ${wr.pid})`;
  const why = r.syscalls === 0 && r.cores >= 0.3 ? `, because ${r.comm} is busy with its own work instead (${r.cores} cores now, ${r.averagePercent}% of a core on average for ${r.age})` : r.syscalls === 0 ? `; ${r.comm} is not reading at all right now` : `; ${r.comm} reads, but slower than it gets output`;
  problems.push(`- STUCK: in ${groupName(x.group)}, ${who} has ${kb(wr.queued + x.unread)} of output that ${r.comm} (pid ${r.pid}) has not read yet${why}. Until it is read, ${wr.comm} cannot continue.`);
}
for (const h of hogs) {
  mentioned.add(h.pid);
  problems.push(`- POSSIBLE ENDLESS LOOP: ${progName(h.pid, h.comm)} (pid ${h.pid}) in ${groupName(h.group)} uses a whole core now and ${h.averagePercent}% of a core on average for ${h.age}.`);
}
for (const h of heavy.filter((h) => !mentioned.has(h.pid) && h.averagePercent >= 50 && h.ageSeconds >= 1800)) {
  problems.push(`- BUSY FOR LONG: ${h.comm} (pid ${h.pid}) in ${groupName(h.group)} has used ${h.averagePercent}% of a core on average for ${h.age} (${h.cores >= 0.05 ? `${h.cores} cores now` : 'quiet right now'}). Fine for a build or benchmark, suspicious for anything else.`);
}
for (const g of groups) {
  if (g.throttled) problems.push(`- LIMITED: ${groupName(g.key)} was held back by its CPU limit for ${g.throttledSeconds}s of the window.`);
  if (g.oomKills) problems.push(`- MEMORY: in ${groupName(g.key)}, ${g.oomKills} program(s) were killed for lack of memory since it started.`);
  if (g.pidsMax && g.pids >= g.pidsMax * 0.8) problems.push(`- PROCESS LIMIT: ${groupName(g.key)} uses ${g.pids} of its ${g.pidsMax} process slots; new programs will fail to start at the limit.`);
}
if (host.memoryWaitPercent >= 5) problems.push(`- MEMORY: programs waited for memory ${host.memoryWaitPercent}% of the time.`);
S.push(...problems);
for (const g of groups.filter((g) => g.zombies >= 50)) S.push(`- Leftovers (harmless for CPU): ${groupName(g.key)} has ${g.zombies} finished processes nobody cleaned up${g.zombieParents?.[0]?.parent?.includes('no --init') ? ' (its container runs without --init)' : ''}; they only take process slots.`);
S.push(`- Memory: ${gb(host.memory.total - host.memory.available)} of ${gb(host.memory.total)} GB used${gb(host.memory.swapUsed) > 0 ? `, ${gb(host.memory.swapUsed)} GB swapped out` : ''}.`);
if (!problems.length) S.push('- Nothing looks wrong.');

L.push('');
L.push(`This diagnosis used ${host.diagnosisCores} cores during the window (${host.diagnosisCpuSeconds} CPU s in total), counted in "SSH sessions".`);

console.log('AF_JSON:' + JSON.stringify({ summary: S, report: L, host, groups: groups.map(({ facts, ...g }) => ({ ...g, task: facts?.url ? { url: facts.url, tool: facts.tool, model: facts.model, requestedBy: facts.requestedBy || null, execution: facts.execution || null, startedAt: facts.startedAt } : null })), nested, kernelCores, unaccounted, hogs, busy: busyProcs, stalls, heavy }));
