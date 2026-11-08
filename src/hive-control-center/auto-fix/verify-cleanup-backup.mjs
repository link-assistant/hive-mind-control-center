// Host module: revalidate the complete backup before a destructive cleanup.
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const manifest = PARAMS.manifest;
if (manifest?.schema !== 'auto-fix-failed-cleanup-v1' || manifest.preservationVerified !== true) throw new Error('A verified failed-cleanup manifest is required');
if (!Array.isArray(manifest.targets) || !manifest.targets.length) throw new Error('No cleanup targets');
const directory = fs.realpathSync(manifest.backupDirectory);
if (!directory.startsWith('/root/.hive-mind/failed-task-backups/')) throw new Error('Unexpected backup location');
const receipt = JSON.parse(fs.readFileSync(path.join(directory, 'receipt.json'), 'utf8'));
if (receipt.preservationVerified !== true || receipt.archive?.compression_test_passed !== true || receipt.archive.kind !== 'complete-stopped-writable-layers') throw new Error('Server preservation receipt is incomplete');
if (JSON.stringify(receipt.archive) !== JSON.stringify(manifest.archive)) throw new Error('Backup receipt differs from the reviewed manifest');
const archive = fs.realpathSync(manifest.archive.path);
if (!archive.startsWith(directory + '/') || !fs.statSync(archive).isFile() || fs.statSync(archive).size !== manifest.archive.bytes) throw new Error('Backup is missing or changed');
const sha = crypto.createHash('sha256');
for await (const chunk of fs.createReadStream(archive, { highWaterMark: 8 * 1024 * 1024 })) sha.update(chunk);
if (sha.digest('hex') !== manifest.archive.sha256) throw new Error('Backup SHA-256 does not match');

const names = new Set();
for (const target of manifest.targets) {
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(target.name) || !/^[0-9a-f]{64}$/.test(target.id) || names.has(target.name)) throw new Error('Invalid or duplicate cleanup target');
  names.add(target.name);
  const backed = receipt.targets.find((t) => t.name === target.name && t.id === target.id);
  if (!backed || backed.finishedAt !== target.finishedAt || backed.exitCode !== target.exitCode || target.exitCode === 0) throw new Error('Target is not the preserved failed attempt');
  if (backed.execution !== target.execution || backed.reportUrl !== target.reportUrl || backed.failureComment !== target.failureComment) throw new Error('Target reporting coverage differs from the receipt');
  if (!/^https:\/\/github\.com\//.test(target.reportUrl || '') || !/^https:\/\/github\.com\/.+#issuecomment-\d+$/.test(target.failureComment || '')) throw new Error('Verified report coverage is required');
  const current = JSON.parse(execFileSync('docker', ['inspect', target.id], { encoding: 'utf8' }))[0];
  if (current.Name !== '/' + target.name || current.State.Running || current.State.Status !== 'exited' || current.State.FinishedAt !== target.finishedAt || current.State.ExitCode !== target.exitCode) throw new Error('Preserved target changed: ' + target.name);
}
const disk = fs.statfsSync('/');
console.log('AF_JSON:' + JSON.stringify({ verified: true, archive: manifest.archive.path, bytes: manifest.archive.bytes, targets: manifest.targets.length, hostDiskFreeBytes: disk.bavail * disk.bsize }));
