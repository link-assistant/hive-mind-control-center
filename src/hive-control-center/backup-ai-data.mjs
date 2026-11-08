#!/usr/bin/env node

const { use } = eval(
  await fetch('https://unpkg.com/use-m@8.16.4/use.js').then((u) => u.text())
);

// Versions are pinned on purpose: an unpinned `command-stream` silently picked
// up 2.0.0 (Node >=22, node-pty without linux-x64 prebuilds) and broke deploys
// on Node 20 hosts without a build toolchain (link-foundation/command-stream#218).
// Workaround for link-foundation/use-m#78: that failed install deleted the
// `command-stream-v-latest` alias but left its bin symlink dangling, so every
// later alias install died with EEXIST. Drop such a dead link before use().
await (async () => {
  const { execSync } = await import('node:child_process');
  const { lstatSync, existsSync, readlinkSync, unlinkSync } = await import('node:fs');
  const { join } = await import('node:path');
  try {
    const prefix = execSync('npm prefix -g', { encoding: 'utf8' }).trim();
    const bin = join(prefix, process.platform === 'win32' ? '' : 'bin', 'command-stream');
    if (lstatSync(bin).isSymbolicLink() && !existsSync(bin)
        && readlinkSync(bin).includes('command-stream-v-')) {
      unlinkSync(bin);
    }
  } catch {}
})();

const { $ } = await use('command-stream@1.6.2');
const { makeConfig } = await use('lino-arguments@0.3.0');

import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';

const config = makeConfig({
  yargs: ({ yargs, getenv }) =>
    yargs
      .version(false)
      .help(false)
      .option('server-ip', { default: getenv('SERVER_IP') })
      .option('server-user', { default: getenv('SERVER_USER') })
      .option('server-pass', { default: getenv('SERVER_PASS') })
      .option('repo', { default: 'konard/ai-sessions', description: 'GitHub repo to push backup to' })
      .option('verbose', { type: 'boolean', default: false })
      .option('dangerously-show-secrets', { type: 'boolean', default: false }),
});

const VERBOSE = config.verbose;
const SHOW_SECRETS = config.dangerouslyShowSecrets;
const mask = (v) => SHOW_SECRETS ? v : '***';
const log = (...args) => { if (VERBOSE) console.log('[DEBUG]', ...args); };

const IP = config.serverIp;
const USER = config.serverUser;
const PASS = config.serverPass;
const REPO = config.repo;

const missing = [];
if (!IP) missing.push('SERVER_IP');
if (!USER) missing.push('SERVER_USER');
if (!PASS) missing.push('SERVER_PASS');
if (missing.length) {
  console.error(`>>> ERROR: Missing required .lenv values: ${missing.join(', ')}`);
  process.exit(1);
}

const SSH_OPTS = '-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=10 -o LogLevel=ERROR';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ssh = async (command, { silent = false, ignoreErrors = false } = {}) => {
  if (!silent) {
    console.log(`>>> sshpass -p '${mask(PASS)}' ssh ${SSH_OPTS} ${USER}@${IP} ${command}`);
  }
  try {
    const result = await $`sshpass -p ${PASS} ssh ${SSH_OPTS.split(' ')} ${USER}@${IP} ${command}`;
    log(`Exit code: ${result.code}`);
    return result;
  } catch (error) {
    log(`Command failed (code ${error.code}):`, error.message || error);
    if (!ignoreErrors) throw error;
    return error;
  }
};

// Format bytes as human-readable
const fmtBytes = (n) => {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(2)} MiB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GiB`;
};

const fmtDuration = (ms) => {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m${s % 60}s`;
};

// Stream `cat REMOTE_FILE` over ssh into a local file, with live progress
// against a known total size. Returns { ok, bytes }.
const sshStreamFile = async (remoteFile, totalBytes, localTarPath) => {
  const { spawn } = await import('node:child_process');
  const { createWriteStream } = await import('node:fs');

  const remoteCmd = `cat ${JSON.stringify(remoteFile)}`;
  console.log(`>>> sshpass -p '${mask(PASS)}' ssh ${SSH_OPTS} ${USER}@${IP} ${remoteCmd} > ${localTarPath}`);

  return new Promise((resolvePromise) => {
    const args = ['-p', PASS, 'ssh', ...SSH_OPTS.split(' '), `${USER}@${IP}`, remoteCmd];
    const child = spawn('sshpass', args, { stdio: ['ignore', 'pipe', 'pipe'] });

    const out = createWriteStream(localTarPath);
    let bytes = 0;
    let lastReported = 0;
    let lastTime = Date.now();
    const startTime = lastTime;
    let stderrBuf = '';

    const onSigint = () => { try { child.kill('SIGTERM'); } catch {} };
    process.on('SIGINT', onSigint);

    child.stdout.on('data', (chunk) => {
      bytes += chunk.length;
      const now = Date.now();
      if (now - lastTime >= 500) {
        const deltaBytes = bytes - lastReported;
        const deltaSec = (now - lastTime) / 1000;
        const rate = deltaBytes / deltaSec;
        const pct = totalBytes > 0 ? (bytes / totalBytes) * 100 : 0;
        const etaSec = rate > 0 && totalBytes > bytes ? (totalBytes - bytes) / rate : 0;
        const etaStr = etaSec > 0 ? `, ETA ${fmtDuration(etaSec * 1000)}` : '';
        process.stderr.write(
          `\r    ${fmtBytes(bytes)} / ${fmtBytes(totalBytes)}  ${pct.toFixed(1)}%  (${fmtBytes(rate)}/s, elapsed ${fmtDuration(now - startTime)}${etaStr})   `
        );
        lastReported = bytes;
        lastTime = now;
      }
    });

    child.stdout.pipe(out);
    child.stderr.on('data', (chunk) => { stderrBuf += chunk.toString(); });

    child.on('error', (err) => {
      process.stderr.write('\n');
      process.off('SIGINT', onSigint);
      console.error('>>> spawn error:', err.message);
      resolvePromise({ ok: false, bytes, stderr: stderrBuf });
    });

    child.on('close', (code, signal) => {
      out.end();
      process.stderr.write('\n');
      process.off('SIGINT', onSigint);
      const elapsed = Date.now() - startTime;
      const avgRate = bytes / Math.max(elapsed / 1000, 0.001);
      console.log(
        `>>> Transfer ${code === 0 ? 'complete' : 'FAILED'}: ${fmtBytes(bytes)} in ${fmtDuration(elapsed)} (avg ${fmtBytes(avgRate)}/s)`
      );
      if (stderrBuf.trim()) {
        console.log('>>> remote stderr:');
        console.log(stderrBuf.split('\n').map((l) => `    ${l}`).join('\n'));
      }
      if (code === 0 && bytes === totalBytes) {
        resolvePromise({ ok: true, bytes });
      } else if (code === 0 && bytes !== totalBytes) {
        console.error(`>>> ERROR: size mismatch — expected ${totalBytes}, got ${bytes}`);
        resolvePromise({ ok: false, bytes, code, signal });
      } else {
        resolvePromise({ ok: false, bytes, code, signal, stderr: stderrBuf });
      }
    });
  });
};

// Extract a tar.gz locally with live file-count progress.
// Prefers gtar (GNU tar from coreutils) when available because it handles
// long pathnames and unusual filenames better than macOS's bsdtar.
const extractTar = async (tarPath, destDir) => {
  const { spawn, spawnSync } = await import('node:child_process');
  const haveGtar = spawnSync('command', ['-v', 'gtar'], { shell: true }).status === 0;
  const tarBin = haveGtar ? 'gtar' : 'tar';
  console.log(`>>> ${tarBin} -xzf ${tarPath} -C ${destDir}  (verbose; counting files)`);
  return new Promise((resolvePromise) => {
    const child = spawn(tarBin, ['-xzvf', tarPath, '-C', destDir], { stdio: ['ignore', 'pipe', 'pipe'] });
    let count = 0;
    let lastTime = Date.now();
    const startTime = lastTime;
    let stderrTail = [];

    const onLine = (line) => {
      if (!line) return;
      count++;
      const now = Date.now();
      if (now - lastTime >= 300) {
        process.stderr.write(`\r    ${count} files extracted  (${fmtDuration(now - startTime)})   `);
        lastTime = now;
      }
      // Keep last few lines of stderr for diagnostics on failure.
      stderrTail.push(line);
      if (stderrTail.length > 20) stderrTail.shift();
    };

    let stdoutBuf = '';
    let stderrBuf = '';
    child.stdout.on('data', (c) => {
      stdoutBuf += c.toString();
      const parts = stdoutBuf.split('\n');
      stdoutBuf = parts.pop();
      for (const l of parts) onLine(l);
    });
    child.stderr.on('data', (c) => {
      stderrBuf += c.toString();
      const parts = stderrBuf.split('\n');
      stderrBuf = parts.pop();
      for (const l of parts) onLine(l);
    });

    const onSigint = () => { try { child.kill('SIGTERM'); } catch {} };
    process.on('SIGINT', onSigint);

    child.on('close', (code) => {
      process.stderr.write('\n');
      process.off('SIGINT', onSigint);
      const elapsed = Date.now() - startTime;
      console.log(`>>> Extract ${code === 0 ? 'complete' : 'FAILED'}: ${count} entries in ${fmtDuration(elapsed)}`);
      if (code !== 0) {
        console.log('>>> last extract output:');
        console.log(stderrTail.map((l) => `    ${l}`).join('\n'));
      }
      resolvePromise(code === 0);
    });
    child.on('error', (err) => {
      process.stderr.write('\n');
      process.off('SIGINT', onSigint);
      console.error('>>> tar spawn error:', err.message);
      resolvePromise(false);
    });
  });
};

const checkSshAvailable = async () => {
  try {
    const result = await $({ mirror: false })`sshpass -p ${PASS} ssh ${SSH_OPTS.split(' ')} ${USER}@${IP} echo up`;
    return result.code === 0;
  } catch (error) {
    const code = error.code ?? error.exitCode;
    if (code === 5) {
      console.error('>>> ERROR: Invalid password. Check SERVER_PASS in .lenv');
      process.exit(1);
    }
    if (code === 6) {
      console.error('>>> ERROR: Unknown host key. Check SERVER_IP in .lenv');
      process.exit(1);
    }
    return false;
  }
};

const sh = async (cmd, opts = {}) => {
  const { cwd, ignoreErrors = false, silent = false } = opts;
  if (!silent) console.log(`>>> ${cwd ? `(in ${cwd}) ` : ''}${cmd}`);
  try {
    const result = cwd
      ? await $({ cwd })`sh -c ${cmd}`
      : await $`sh -c ${cmd}`;
    return result;
  } catch (error) {
    log(`shell command failed:`, error.message || error);
    if (!ignoreErrors) throw error;
    return error;
  }
};

const __dirname = dirname(fileURLToPath(import.meta.url));

let step = 0;
const nextStep = (msg) => console.log(`\n>>> Step ${++step}: ${msg}`);

// Verify `gh` is installed locally
nextStep('Checking local prerequisites (gh, sshpass, scp)');
const ghCheck = await sh('gh --version', { ignoreErrors: true, silent: true });
if (!ghCheck || ghCheck.code !== 0) {
  console.error('>>> ERROR: `gh` CLI not found locally. Install it from https://cli.github.com/');
  process.exit(1);
}
const ghAuth = await sh('gh auth status', { ignoreErrors: true, silent: true });
if (!ghAuth || ghAuth.code !== 0) {
  console.error('>>> ERROR: `gh` is not authenticated. Run `gh auth login` first.');
  process.exit(1);
}
const sshpassCheck = await sh('command -v sshpass', { ignoreErrors: true, silent: true });
if (!sshpassCheck || sshpassCheck.code !== 0) {
  console.error('>>> ERROR: `sshpass` not found locally. Install with `brew install hudochenkov/sshpass/sshpass` on macOS.');
  process.exit(1);
}

nextStep('Checking SSH availability');
let attempts = 0;
while (!(await checkSshAvailable())) {
  attempts++;
  if (attempts > 6) {
    console.error('>>> ERROR: SSH unavailable after 60s. Aborting.');
    process.exit(1);
  }
  console.log('>>> SSH not available, retrying in 10s');
  await sleep(10000);
}
console.log('>>> Server is reachable');

// Determine remote home directory
nextStep('Resolving remote home directory');
const homeResult = await ssh("echo $HOME", { silent: true });
const REMOTE_HOME = homeResult.stdout.trim();
if (!REMOTE_HOME) {
  console.error('>>> ERROR: Could not resolve remote $HOME');
  process.exit(1);
}
console.log(`>>> Remote home: ${REMOTE_HOME}`);

const REMOTE_BASE = `${REMOTE_HOME}/.hive-mind`;
const REMOTE_TARGETS = [
  { remote: `${REMOTE_BASE}/claude`, name: 'claude', type: 'dir' },
  { remote: `${REMOTE_BASE}/codex`, name: 'codex', type: 'dir' },
  { remote: `${REMOTE_BASE}/claude.json`, name: 'claude.json', type: 'file' },
];

// Check which targets actually exist on the server
nextStep('Checking which targets exist on server');
const presentTargets = [];
for (const t of REMOTE_TARGETS) {
  const check = await ssh(`test -e ${t.remote} && echo yes || echo no`, { silent: true });
  const exists = check.stdout.trim() === 'yes';
  console.log(`>>> ${t.remote}: ${exists ? 'EXISTS' : 'missing'}`);
  if (exists) presentTargets.push(t);
}
if (presentTargets.length === 0) {
  console.error('>>> ERROR: None of the target paths exist on the server. Nothing to back up.');
  process.exit(1);
}

// Create a local temp working dir
nextStep('Creating local temp workspace');
const tmpRoot = mkdtempSync(join(tmpdir(), 'ai-sessions-backup-'));
const stagingDir = join(tmpRoot, 'staging');
const repoDir = join(tmpRoot, 'repo');
mkdirSync(stagingDir, { recursive: true });
console.log(`>>> Workspace: ${tmpRoot}`);

// Cleanup handler — idempotent, runs on normal exit, Ctrl-C, or unhandled errors.
let cleanedUp = false;
const cleanup = () => {
  if (cleanedUp) return;
  cleanedUp = true;
  try {
    rmSync(tmpRoot, { recursive: true, force: true });
    console.log(`>>> Cleaned up ${tmpRoot}`);
  } catch (e) {
    log('cleanup error:', e.message);
  }
};
process.on('exit', cleanup);
// On SIGINT, let any child-process SIGINT handlers run first, then clean up.
// Use setImmediate so spawned children get the signal and we don't yank tmp out from under them.
process.on('SIGINT', () => {
  console.log('\n>>> Interrupted by user. Cleaning up...');
  setImmediate(() => { cleanup(); process.exit(130); });
});
process.on('uncaughtException', (err) => {
  console.error('>>> Uncaught exception:', err.message);
  cleanup();
  process.exit(1);
});

// Build the archive on the server first so we know its exact size before
// transferring; this lets us show real progress (downloaded / total, ETA).
const remoteTar = `/tmp/ai-sessions-backup-${process.pid}-${Date.now()}.tar.gz`;
const entries = presentTargets.map((t) => t.name);

// Ensure we always try to clean up the remote tar — even on early exit.
const cleanupRemoteTar = async () => {
  try {
    await ssh(`rm -f ${remoteTar}`, { silent: true, ignoreErrors: true });
  } catch {}
};
process.on('exit', () => {
  // Fire-and-forget; can't await in 'exit' handler. Best-effort.
  // The server-side file is small in absolute terms vs. the data being moved.
});

nextStep(`Creating archive on server: ${remoteTar}`);
const entriesQuoted = entries.map((e) => JSON.stringify(e)).join(' ');
const tarCreateResult = await ssh(
  `tar -czf ${remoteTar} -C ${JSON.stringify(REMOTE_BASE)} ${entriesQuoted}`,
  { ignoreErrors: true }
);
if (!tarCreateResult || tarCreateResult.code !== 0) {
  console.error('>>> ERROR: Remote tar creation failed');
  if (tarCreateResult?.stderr) console.error(tarCreateResult.stderr.toString());
  await cleanupRemoteTar();
  process.exit(1);
}

nextStep('Reading archive size');
const sizeResult = await ssh(`stat -c %s ${remoteTar}`, { silent: true, ignoreErrors: true });
const remoteTarBytes = parseInt((sizeResult?.stdout || '').trim(), 10);
if (!remoteTarBytes || isNaN(remoteTarBytes)) {
  console.error('>>> ERROR: Could not stat remote archive');
  await cleanupRemoteTar();
  process.exit(1);
}
console.log(`>>> Archive size: ${fmtBytes(remoteTarBytes)}`);

nextStep('Streaming archive from server');
const localTar = join(tmpRoot, 'backup.tar.gz');
const pullResult = await sshStreamFile(remoteTar, remoteTarBytes, localTar);
// Clean up the remote tar regardless of success/failure
await cleanupRemoteTar();
if (!pullResult.ok) {
  console.error('>>> ERROR: Failed to stream archive from server');
  process.exit(1);
}

nextStep('Extracting archive into staging');
const extractOk = await extractTar(localTar, stagingDir);
if (!extractOk) {
  console.error('>>> ERROR: tar extract failed; aborting before touching the repo');
  process.exit(1);
}

// Sanity-check: every expected entry must now exist in staging
nextStep('Verifying staged files');
for (const t of presentTargets) {
  const p = join(stagingDir, t.name);
  if (!existsSync(p)) {
    console.error(`>>> ERROR: Expected staged entry missing: ${p}`);
    process.exit(1);
  }
  console.log(`>>> OK: ${t.name}`);
}

// Clone the repo using gh
nextStep(`Cloning ${REPO}`);
const clone = await sh(`gh repo clone ${REPO} ${repoDir}`, { ignoreErrors: true });
if (clone.code !== 0) {
  console.error(`>>> ERROR: Failed to clone ${REPO}. Make sure it exists and you have access.`);
  process.exit(1);
}

// Determine default branch and ensure we are on it, up-to-date
nextStep('Determining default branch');
const defaultBranchResult = await sh(`gh repo view ${REPO} --json defaultBranchRef -q .defaultBranchRef.name`, { silent: true });
const defaultBranch = defaultBranchResult.stdout.trim() || 'main';
console.log(`>>> Default branch: ${defaultBranch}`);

nextStep(`Checking out and pulling ${defaultBranch}`);
await sh(`git checkout ${defaultBranch}`, { cwd: repoDir });
await sh(`git pull --ff-only origin ${defaultBranch}`, { cwd: repoDir });

const now = new Date();
const pad = (n) => String(n).padStart(2, '0');
const stamp = `${now.getUTCFullYear()}-${pad(now.getUTCMonth() + 1)}-${pad(now.getUTCDate())}T${pad(now.getUTCHours())}-${pad(now.getUTCMinutes())}-${pad(now.getUTCSeconds())}Z`;

// Layout: write into a directory named after the server IP + timestamp at repo root
const backupSubdir = join(repoDir, `${IP}`, stamp);
mkdirSync(backupSubdir, { recursive: true });

nextStep('Copying staged files into repo');
for (const t of presentTargets) {
  const src = join(stagingDir, t.name);
  const dst = join(backupSubdir, t.name);
  await sh(`cp -a ${JSON.stringify(src)} ${JSON.stringify(dst)}`, { silent: false });
}

// Write a small manifest
const manifestPath = join(backupSubdir, 'MANIFEST.json');
const manifest = {
  server_ip: IP,
  server_user: USER,
  remote_home: REMOTE_HOME,
  remote_base: REMOTE_BASE,
  taken_at_utc: now.toISOString(),
  targets: presentTargets.map((t) => ({ remote: t.remote, name: t.name, type: t.type })),
};
const { writeFileSync } = await import('node:fs');
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
console.log(`>>> Wrote manifest: ${manifestPath}`);

// Stage, commit, push
nextStep('Committing backup');
await sh(`git add -A`, { cwd: repoDir });

// Verify there is something to commit
const statusResult = await sh(`git status --porcelain`, { cwd: repoDir, silent: true });
if (!statusResult.stdout.trim()) {
  console.error('>>> ERROR: No changes to commit (staging copy may have failed).');
  process.exit(1);
}

const commitMsg = `Backup ${IP} @ ${stamp}`;
await sh(`git commit -m ${JSON.stringify(commitMsg)}`, { cwd: repoDir });

nextStep(`Pushing to ${REPO} (${defaultBranch})`);
// Rebase on top of any new commits that may have landed while we were working
await sh(`git pull --rebase origin ${defaultBranch}`, { cwd: repoDir, ignoreErrors: true });
await sh(`git push origin ${defaultBranch}`, { cwd: repoDir });

console.log(`\n>>> Backup complete.`);
console.log(`>>> View: https://github.com/${REPO}/tree/${defaultBranch}/${IP}/${stamp}`);
