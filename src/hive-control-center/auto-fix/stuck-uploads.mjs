// Runs on the host as root (host Node.js) via auto-fix.mjs, which prepends
// `const PARAMS = { sampleSeconds: 5, minMinutes: 30, cpuPercent: 80, act: false, maxTriggerScanBytes: 67108864 };`.
// Read-only unless PARAMS.act is true.
//
// Lesson of 2026-11-12: two gh-upload-log processes in hive-mind burned a full
// core each for over an hour on one 222 MB log. They were not uploading: both
// had stopped at the same file offsets. The sanitizer's netrc detector treats
// any line starting with `default ` as the start of a netrc block. The line
// `default = ["macro"]` never completes `machine|default login ... password ...`,
// so releaseBoundary holds the whole log and rescans a growing slice (quadratic
// CPU). The bot restarted the upload after each kill, so killing alone is not a
// fix; it is a way to stop the CPU burn until the dependency is patched.
// Upstream report: https://github.com/link-foundation/gh-upload-log/issues/65
//
// This module records the evidence that diagnosis used by hand:
// - process age and lifetime CPU (a whole core for --stuck-upload-minutes),
// - read/write fd paths and positions, sampled twice (no progress),
// - the first netrc-like `default` line in the input and its byte offset,
// - the container and the redacted command line.
// It can optionally kill only confirmed stuck uploads, after rechecking the
// process start time so a recycled PID is never killed.
import fs from 'node:fs';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

const HZ = 100; // USER_HZ, 100 on every Linux build Docker supports
const run = (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 30000 });
  return r.status === 0 ? (r.stdout || '').trim() : '';
};
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
    if (fd !== undefined)
      try {
        fs.closeSync(fd);
      } catch {}
  }
};
const redact = (text) =>
  text
    .replace(/\b(gh[pousr]_|github_pat_)[A-Za-z0-9_]+/g, '$1***')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, 'sk-***')
    .replace(/\b\d{6,}:[A-Za-z0-9_-]{30,}\b/g, '***:***')
    .replace(
      /((?:token|password|passwd|secret|api[_-]?key)[=: ]+)\S+/gi,
      '$1***'
    );
const round = (n, d = 1) => Math.round(n * 10 ** d) / 10 ** d;
const kb = (n) =>
  n >= 1048576
    ? `${round(n / 1048576)} MB`
    : n >= 1024
      ? `${Math.round(n / 1024)} KB`
      : `${n} B`;
const duration = (seconds) => {
  if (seconds >= 3600)
    return `${Math.floor(seconds / 3600)}h${String(Math.floor((seconds % 3600) / 60)).padStart(2, '0')}m`;
  if (seconds >= 60)
    return `${Math.floor(seconds / 60)}m${String(Math.floor(seconds % 60)).padStart(2, '0')}s`;
  return `${Math.round(seconds)}s`;
};

const names = new Map(
  run('docker', ['ps', '--no-trunc', '--format', '{{.ID}} {{.Names}}'])
    .split('\n')
    .filter(Boolean)
    .map((l) => l.split(' '))
);
const containerOf = (pid) => {
  const id = /([0-9a-f]{64})/.exec(read(`/proc/${pid}/cgroup`) || '')?.[1];
  return id ? names.get(id) || id.slice(0, 12) : null;
};

const statOf = (pid) => {
  const stat = read(`/proc/${pid}/stat`);
  if (!stat) return null;
  const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  return {
    comm: stat.slice(stat.indexOf('(') + 1, stat.lastIndexOf(')')),
    ticks: Number(fields[11]) + Number(fields[12]),
    startTicks: Number(fields[19]),
  };
};
const uptime = Number(read('/proc/uptime')?.split(' ')[0] ?? 0);

const isUpload = (args) => {
  const text = args.join(' ');
  if (/stuck-uploads\.mjs/.test(text)) return false;
  return (
    /(?:^|\/)(?:gh-upload-log|gh-upload-file)(?:\s|$)/.test(text) ||
    /sensitive-data-sanitizer/.test(text)
  );
};
const hostPath = (pid, path) =>
  path.startsWith('/') ? `/proc/${pid}/root${path}` : null;
const regular = (path) => {
  try {
    const s = fs.statSync(path);
    return s.isFile() ? s.size : null;
  } catch {
    return null;
  }
};

const filesOf = (pid) => {
  const files = [];
  let fds = [];
  try {
    fds = fs.readdirSync(`/proc/${pid}/fd`);
  } catch {}
  for (const fd of fds) {
    let path;
    try {
      path = fs.readlinkSync(`/proc/${pid}/fd/${fd}`);
    } catch {
      continue;
    }
    if (
      !path.startsWith('/') ||
      path.startsWith('/dev/') ||
      path.startsWith('/proc/')
    )
      continue;
    const real = hostPath(pid, path);
    const size = real && regular(real);
    if (size === null) continue;
    const info = read(`/proc/${pid}/fdinfo/${fd}`, 4096) || '';
    const pos = Number(/^pos:\s*(\d+)/m.exec(info)?.[1] ?? 0);
    files.push({ fd: Number(fd), path, pos, size });
  }
  return files;
};

const inputOf = (pid, args) => {
  const script = args.findIndex((a) =>
    /(?:^|\/)(?:gh-upload-log|gh-upload-file)$/.test(a)
  );
  const candidates = args
    .slice(script + 1)
    .filter((a) => a.startsWith('/') && !a.startsWith('--'));
  for (const path of candidates) {
    if (regular(hostPath(pid, path)) !== null) return path;
  }
  return null;
};
const versionsOf = (pid) => {
  const version = (name) => {
    const file = `/proc/${pid}/root/home/box/.bun/install/global/node_modules/${name}/package.json`;
    try {
      return JSON.parse(read(file) || '{}').version ?? null;
    } catch {
      return null;
    }
  };
  return {
    ghUploadLog: version('gh-upload-log'),
    sensitiveDataSanitizer: version(
      '@link-foundation/sensitive-data-sanitizer'
    ),
  };
};

// The first `default` line that is not a netrc keyword. This is the line that
// makes the sanitizer hold the rest of the file in releaseBoundary.
const triggerOf = (pid, input) => {
  const max = Number(PARAMS.maxTriggerScanBytes) || 64 * 1024 * 1024;
  if (!input || !Number.isFinite(max) || max <= 0) return null;
  const file = hostPath(pid, input);
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(max);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    const text = buf.toString('utf8', 0, n);
    let byte = 0;
    for (const line of text.split('\n')) {
      if (
        /^\s*default(?:\s|$)/.test(line) &&
        !/^\s*default\s+(?:login|password|account|macdef)\b/.test(line) &&
        line.trim() !== 'default'
      ) {
        return { byte, line: redact(line.slice(0, 160)) };
      }
      byte += Buffer.byteLength(line) + 1;
    }
  } catch {
    return null;
  } finally {
    if (fd !== undefined)
      try {
        fs.closeSync(fd);
      } catch {}
  }
  return null;
};

const matching = () => {
  const out = [];
  for (const pid of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(pid)) continue;
    const args = (read(`/proc/${pid}/cmdline`, 8192) || '')
      .split('\0')
      .filter(Boolean);
    if (!isUpload(args)) continue;
    const stat = statOf(pid);
    if (!stat) continue;
    out.push({ pid: Number(pid), args, stat });
  }
  return out;
};

const sample = (entry) => {
  const stat = statOf(entry.pid) || entry.stat;
  return { pid: entry.pid, stat, files: filesOf(entry.pid), at: Date.now() };
};

const found = matching();
const first = new Map(found.map((e) => [e.pid, sample(e)]));
await new Promise((resolve) =>
  setTimeout(resolve, (PARAMS.sampleSeconds || 5) * 1000)
);
const uploads = [];
const hung = [];
for (const entry of found) {
  const a = first.get(entry.pid);
  const b = sample(entry);
  if (!a || a.stat.startTicks !== b.stat.startTicks) continue; // gone or PID reused
  const seconds = Math.max((b.at - a.at) / 1000, 0.001);
  const elapsedSeconds = uptime - b.stat.startTicks / HZ;
  const cpuPercent = ((b.stat.ticks - a.stat.ticks) / HZ / seconds) * 100;
  const averagePercent =
    elapsedSeconds > 0 ? (b.stat.ticks / HZ / elapsedSeconds) * 100 : 0;
  const before = new Map(a.files.map((f) => [f.fd, f]));
  const files = b.files.map((f) => {
    const old = before.get(f.fd);
    return { ...f, delta: old ? f.pos - old.pos : 0 };
  });
  const progressBytes = files.reduce((sum, f) => sum + Math.abs(f.delta), 0);
  const input = inputOf(entry.pid, entry.args);
  const busy = averagePercent >= (PARAMS.cpuPercent ?? 80) && progressBytes < 1;
  const confirmed = elapsedSeconds >= (PARAMS.minMinutes ?? 30) * 60 && busy;
  const upload = {
    pid: entry.pid,
    startTicks: b.stat.startTicks,
    comm: b.stat.comm,
    container: containerOf(entry.pid),
    command: redact(entry.args.join(' ')).slice(0, 240),
    versions: versionsOf(entry.pid),
    elapsedSeconds: Math.round(elapsedSeconds),
    elapsed: duration(elapsedSeconds),
    cpuPercent: round(cpuPercent),
    averagePercent: round(averagePercent),
    progressBytes,
    input,
    files,
    trigger: confirmed ? triggerOf(entry.pid, input) : null,
    confirmed,
    suspicious: busy && !confirmed,
  };
  uploads.push(upload);
  if (upload.confirmed) hung.push(upload);
}
uploads.sort((x, y) => y.averagePercent - x.averagePercent);
const suspicious = uploads.filter((u) => u.suspicious);

const killed = [];
if (PARAMS.act) {
  for (const upload of hung) {
    const current = statOf(upload.pid);
    if (!current || current.startTicks !== upload.startTicks) {
      killed.push({
        pid: upload.pid,
        action: 'skipped: process changed or exited',
      });
      continue;
    }
    try {
      process.kill(upload.pid, 'SIGTERM');
      await new Promise((resolve) => setTimeout(resolve, 2000));
      if (statOf(upload.pid)?.startTicks === upload.startTicks)
        process.kill(upload.pid, 'SIGKILL');
      killed.push({ pid: upload.pid, action: 'killed' });
    } catch (error) {
      killed.push({
        pid: upload.pid,
        action: `could not kill: ${error.message}`,
      });
    }
  }
}

console.log(
  'AF_JSON:' +
    JSON.stringify({
      sampleSeconds: PARAMS.sampleSeconds || 5,
      minMinutes: PARAMS.minMinutes ?? 30,
      cpuPercent: PARAMS.cpuPercent ?? 80,
      act: PARAMS.act === true,
      uploads,
      hung,
      suspicious,
      killed,
    })
);
