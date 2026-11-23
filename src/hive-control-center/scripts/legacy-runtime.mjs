import { execSync } from 'node:child_process';
import { existsSync, lstatSync, readlinkSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

const { use } = eval(await fetch('https://unpkg.com/use-m@8.16.4/use.js').then((response) => response.text()));

// Retain the pinned Node 20-compatible transport for legacy callers. Recover a
// dangling alias from a failed command-stream installation (use-m#78).
try {
  const prefix = execSync('npm prefix -g', { encoding: 'utf8' }).trim();
  const bin = join(prefix, process.platform === 'win32' ? '' : 'bin', 'command-stream');
  if (lstatSync(bin).isSymbolicLink() && !existsSync(bin) && readlinkSync(bin).includes('command-stream-v-')) {
    unlinkSync(bin);
  }
} catch {}

export const { $ } = await use('command-stream@1.6.2');
export const { LinoEnv, makeConfig } = await use('lino-arguments@0.3.0');
