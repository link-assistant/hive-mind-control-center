// Runs on the host as root via `auto-fix.mjs --disk-report`, which prepends
// `const PARAMS = {...};`. Read-only disk accounting:
//   1. Filesystem and inode use for `/`.
//   2. Docker's own accounting: images, containers, volumes and build cache.
//   3. Every container's writable layer (from containerd snapshot usage) and log.
//   4. Image, volume and selected host-directory sizes, including one level of
//      breakdown below large directories.
// Prints one AF_JSON line for auto-fix and a human-readable report.
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

const TOP = Math.max(1, Number(PARAMS.top) || 10);
const TIMEOUT = Math.max(10, Number(PARAMS.timeoutS) || 120);

const run = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    ...opts,
  });
  return {
    code: r.status,
    out: (r.stdout || '').trim(),
    err: (r.stderr || '').trim(),
  };
};

const timed = (cmd, args, timeoutS = TIMEOUT) =>
  run('timeout', [
    '-k',
    '5',
    String(timeoutS),
    'nice',
    '-n',
    '10',
    'ionice',
    '-c3',
    cmd,
    ...args,
  ]);

const gib = (bytes) => `${(Number(bytes || 0) / 2 ** 30).toFixed(2)} GiB`;

const parseSize = (value) => {
  const text = String(value || '')
    .replace(/\s*\(.*\)\s*$/, '')
    .trim();
  const m = /^([\d.]+)\s*([kmgtpe]?i?b)$/i.exec(text);
  if (!m) return 0;
  const n = Number(m[1]);
  const units = {
    b: 1,
    kb: 1e3,
    mb: 1e6,
    gb: 1e9,
    tb: 1e12,
    pb: 1e15,
    eb: 1e18,
    kib: 1024,
    mib: 1024 ** 2,
    gib: 1024 ** 3,
    tib: 1024 ** 4,
    pib: 1024 ** 5,
    eib: 1024 ** 6,
  };
  return Math.round(n * (units[m[2].toLowerCase()] || 0));
};

const statBytes = (file) => {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
};

const duBytes = (dir, timeoutS = TIMEOUT) => {
  if (!dir || !fs.existsSync(dir)) return null;
  const r = timed('du', ['-s', '-x', '-B1', '--', dir], timeoutS);
  if (r.code !== 0) return null;
  const first = r.out.split(/\s+/)[0];
  return Number(first) || 0;
};

const duBreakdown = (dir, timeoutS = TIMEOUT, exclude = []) => {
  if (!dir || !fs.existsSync(dir)) {
    return { bytes: 0, children: [], grandchildren: [] };
  }
  const r = timed(
    'du',
    [
      '-x',
      '-B1',
      '-d2',
      ...exclude.map((item) => `--exclude=${item}`),
      '--',
      dir,
    ],
    timeoutS
  );
  if (r.code !== 0) return { bytes: 0, children: [], grandchildren: [] };
  const rows = r.out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const m = /^(\d+)\s+(.*)$/.exec(line);
      return m ? { bytes: Number(m[1]) || 0, path: m[2] } : null;
    })
    .filter(Boolean);
  const total = rows.find((row) => row.path === dir) || rows.at(-1);
  const prefix = dir.endsWith('/') ? dir : `${dir}/`;
  const depthOf = (rowPath) =>
    rowPath.slice(prefix.length).split('/').filter(Boolean).length;
  const descendants = rows.filter(
    (row) => row.path !== dir && row.path.startsWith(prefix)
  );
  return {
    bytes: total?.bytes || 0,
    children: descendants
      .filter((row) => depthOf(row.path) === 1)
      .sort((a, b) => b.bytes - a.bytes)
      .slice(0, 10),
    grandchildren: descendants
      .filter((row) => depthOf(row.path) === 2)
      .sort((a, b) => b.bytes - a.bytes)
      .slice(0, 30),
  };
};

const filesystem = () => {
  const r = run('df', [
    '-B1',
    '--output=source,fstype,size,used,avail,pcent,target',
    '/',
  ]);
  const line = r.out.split('\n').filter(Boolean).pop() || '';
  const [source, fstype, size, used, avail, pcent, target] =
    line.trim().split(/\s+/);
  const i = run('df', ['-i', '/']);
  const iline = i.out.split('\n').filter(Boolean).pop() || '';
  const inode = iline.trim().split(/\s+/);
  return {
    source,
    fstype,
    size: Number(size) || 0,
    used: Number(used) || 0,
    avail: Number(avail) || 0,
    pcent,
    target,
    inodes: Number(inode[1]) || 0,
    inodesUsed: Number(inode[2]) || 0,
    inodesFree: Number(inode[3]) || 0,
    inodesPcent: inode[4] || '',
  };
};

const dockerRoot = () =>
  run('docker', ['info', '--format', '{{.DockerRootDir}}']).out || 'unknown';

const dockerSystem = () => {
  const r = timed('docker', ['system', 'df', '--format', '{{json .}}'], 60);
  const rows = [];
  if (r.code === 0) {
    for (const line of r.out.split('\n').filter(Boolean)) {
      try {
        const j = JSON.parse(line);
        rows.push({
          type: j.Type || j.type || '',
          total: Number(j.TotalCount || j.totalCount) || 0,
          active: Number(j.Active || j.active) || 0,
          sizeText: j.Size || j.size || '',
          sizeBytes: parseSize(j.Size || j.size),
          reclaimableText: j.Reclaimable || j.reclaimable || '',
        });
      } catch {}
    }
  }
  return { rows, raw: r.code === 0 ? '' : r.out || r.err };
};

const stage = (name) => console.error(`DISK_STAGE ${name}`);

const ctrUsage = (id) => {
  const r = run('ctr', [
    '-n',
    'moby',
    'snapshots',
    '--snapshotter',
    'overlayfs',
    'usage',
    id,
  ]);
  if (r.code !== 0) return null;
  const line = r.out.split('\n').filter(Boolean).pop() || '';
  const size = /([\d.]+)\s*(B|KiB|MiB|GiB|TiB)\b/i.exec(line);
  return size ? parseSize(size[0]) : null;
};

const containers = () => {
  const r = run('docker', [
    'ps',
    '-a',
    '--no-trunc',
    '--format',
    '{{.Names}}\t{{.ID}}\t{{.Image}}\t{{.Status}}',
  ]);
  const list = [];
  for (const line of r.out.split('\n').filter(Boolean)) {
    const [name, id, image, status] = line.split('\t');
    const inspect = run('docker', [
      'inspect',
      '-f',
      '{{.State.Status}}\t{{.LogPath}}',
      name,
    ]);
    const [state, logPath] = inspect.out.split('\t');
    let layerBytes = ctrUsage(id);
    if (layerBytes === null) {
      const fallback = run('docker', [
        'inspect',
        '--size',
        '-f',
        '{{.SizeRw}}',
        name,
      ]);
      layerBytes = Number(fallback.out) || 0;
    }
    list.push({
      name,
      id,
      image,
      status,
      state: state || status,
      layerBytes,
      logPath,
      logBytes: statBytes(logPath),
    });
  }
  return list;
};

const images = () => {
  const r = run('docker', [
    'image',
    'ls',
    '--no-trunc',
    '--format',
    '{{.ID}}\t{{.Repository}}:{{.Tag}}\t{{.Size}}\t{{.CreatedSince}}',
  ]);
  const byId = new Map();
  for (const line of r.out.split('\n').filter(Boolean)) {
    const [id, tag, size, created] = line.split('\t');
    const item = byId.get(id) || {
      id,
      tags: [],
      sizeHint: parseSize(size),
      created,
      bytes: parseSize(size),
    };
    if (tag && !item.tags.includes(tag)) item.tags.push(tag);
    byId.set(id, item);
  }
  const candidates = [...byId.values()]
    .sort((a, b) => b.sizeHint - a.sizeHint)
    .slice(0, Math.max(TOP * 2, 20));
  for (const item of candidates) {
    const exact = run('docker', [
      'image',
      'inspect',
      '-f',
      '{{.Size}}',
      item.id,
    ]);
    if (exact.code === 0 && Number(exact.out)) item.bytes = Number(exact.out);
  }
  return candidates
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, TOP)
    .map((item) => ({ ...item, tags: item.tags.slice(0, 4) }));
};

const volumes = () => {
  const names = run('docker', ['volume', 'ls', '-q'])
    .out.split('\n')
    .filter(Boolean);
  const list = [];
  for (const name of names.slice(0, 100)) {
    const mountpoint = run('docker', [
      'volume',
      'inspect',
      '-f',
      '{{.Mountpoint}}',
      name,
    ]).out;
    list.push({ name, mountpoint, bytes: duBytes(mountpoint, 30) || 0 });
  }
  return list.sort((a, b) => b.bytes - a.bytes).slice(0, TOP);
};

const hostDirs = () => {
  const dirs = [
    { path: '/var/log' },
    { path: '/var/cache' },
    {
      path: '/var/lib',
      exclude: [
        '/var/lib/docker',
        '/var/lib/containerd',
        '/var/lib/containers',
      ],
    },
    { path: '/root' },
    { path: '/usr' },
    { path: '/snap' },
    { path: '/boot' },
    { path: '/home' },
    { path: '/tmp' },
    { path: '/workspace' },
    { path: '/opt' },
    { path: '/srv' },
  ];
  return dirs
    .filter((dir) => fs.existsSync(dir.path))
    .map((dir) => {
      stage(`host-dir ${dir.path}`);
      const item = duBreakdown(dir.path, 90, dir.exclude || []);
      return {
        path: dir.path,
        bytes: item.bytes,
        children: item.children,
        grandchildren: item.grandchildren,
      };
    })
    .sort((a, b) => b.bytes - a.bytes);
};

stage('filesystem');
const df = filesystem();
stage('docker-root');
const root = dockerRoot();
stage('docker-system');
const system = dockerSystem();
stage('containers');
const containerList = containers();
stage('images');
const imageList = images();
stage('volumes');
const volumeList = volumes();
stage('host-directories');
const dirs = hostDirs();
stage('journal');
const journal = run('journalctl', ['--disk-usage']).out.replace(
  /^.*take up /,
  ''
);

const contributors = [
  ...containerList.map((c) => ({
    kind: 'container layer',
    name: c.name,
    bytes: c.layerBytes,
  })),
  ...containerList.map((c) => ({
    kind: 'container log',
    name: c.name,
    bytes: c.logBytes,
  })),
  ...imageList.map((i) => ({
    kind: 'image',
    name: i.tags.join(', ') || i.id.slice(0, 12),
    bytes: i.bytes,
  })),
  ...volumeList.map((v) => ({
    kind: 'volume',
    name: v.name,
    bytes: v.bytes,
  })),
  ...dirs.map((d) => ({
    kind: 'host dir',
    name: d.path,
    bytes: d.bytes,
  })),
].sort((a, b) => b.bytes - a.bytes);

const dockerBytes = system.rows.reduce((sum, row) => sum + row.sizeBytes, 0);
const report = [];
report.push('DISK USAGE (read-only)');
report.push(
  `Filesystem ${df.source} (${df.fstype}) at ${df.target}: ${gib(df.size)} total, ${gib(df.used)} used (${df.pcent}), ${gib(df.avail)} free; inodes ${df.inodesUsed}/${df.inodes} used (${df.inodesPcent})`
);
report.push(`Docker root: ${root}`);
if (system.rows.length) {
  report.push(
    `Docker totals: ${system.rows.map((row) => `${row.type} ${row.sizeText}${row.reclaimableText ? ` (reclaimable ${row.reclaimableText})` : ''}`).join('; ')}`
  );
} else if (system.raw) {
  report.push(`Docker totals: ${system.raw.replace(/\n/g, ' | ')}`);
}
report.push(
  `Docker reported: ${gib(dockerBytes)}; not represented in Docker totals (host files and Docker storage overhead): about ${gib(Math.max(0, df.used - dockerBytes))}`
);
report.push('');
report.push(`Container writable layers and logs (largest ${TOP}):`);
for (const item of [...containerList]
  .sort((a, b) => b.layerBytes + b.logBytes - (a.layerBytes + a.logBytes))
  .slice(0, TOP)) {
  report.push(
    `  ${gib(item.layerBytes + item.logBytes).padStart(9)}  layer ${gib(item.layerBytes).padStart(9)}, log ${gib(item.logBytes).padStart(9)}  ${item.state}  ${item.name}`
  );
}
if (!containerList.length) report.push('  none');
report.push('');
report.push(`Images (largest ${TOP}):`);
for (const item of imageList) {
  report.push(
    `  ${gib(item.bytes).padStart(9)}  ${item.tags.join(', ') || item.id.slice(0, 12)}`
  );
}
if (!imageList.length) report.push('  none');
report.push('');
report.push(`Volumes (largest ${TOP}):`);
for (const item of volumeList) {
  report.push(`  ${gib(item.bytes).padStart(9)}  ${item.name} (${item.mountpoint})`);
}
if (!volumeList.length) report.push('  none');
report.push('');
report.push('Host directories (outside Docker root):');
for (const item of dirs) {
  report.push(`  ${gib(item.bytes).padStart(9)}  ${item.path}`);
  if (item.bytes >= 2 ** 30) {
    for (const child of item.children.slice(0, 5)) {
      report.push(`    ${gib(child.bytes).padStart(9)}  ${child.path}`);
      if (child.bytes >= 2 ** 30) {
        for (const grandchild of item.grandchildren
          .filter((row) => row.path.startsWith(`${child.path}/`))
          .slice(0, 3)) {
          report.push(
            `      ${gib(grandchild.bytes).padStart(9)}  ${grandchild.path}`
          );
        }
      }
    }
  }
}
report.push(`Journal: ${journal || 'unknown'}`);
report.push('');
report.push(`Largest single contributors:`);
for (const item of contributors.slice(0, TOP)) {
  report.push(
    `  ${gib(item.bytes).padStart(9)}  ${item.kind}  ${item.name}`
  );
}

const result = {
  schema: 'auto-fix-disk-usage-v1',
  generatedAt: new Date().toISOString(),
  filesystem: df,
  dockerRoot: root,
  dockerSystem: system.rows,
  containers: containerList,
  images: imageList,
  volumes: volumeList,
  hostDirectories: dirs,
  journal,
  topContributors: contributors.slice(0, TOP),
  report,
};

console.log(report.join('\n'));
console.log('AF_JSON:' + JSON.stringify(result));
