// Container module: update one global dependency, or every global dependency,
// in the hive-mind container. Prints one AF_JSON line.
//
// Lesson of 2026-11-12: gh-upload-log 0.13.1 pinned
// @link-foundation/sensitive-data-sanitizer 0.12.1. The netrc detector in that
// version hangs on `default = [...]` (gh-upload-log#65). The fix has to come
// from a newer gh-upload-log/sanitizer release, so the operator needs a safe way
// to ask what would change and to update just that tool without touching every
// global CLI at once.
//
// The global install is Bun's (`/home/box/.bun/install/global`). `bun update -g
// --latest <name>` updates the named top-level dependency and its transitive
// dependencies; `bun update -g --latest` updates all of them. `--dry-run` is
// passed through, so the same command reports the plan without changing files.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const NAME = /^(?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/i;
const globalDir = process.env.BUN_INSTALL
  ? path.join(process.env.BUN_INSTALL, 'install', 'global')
  : path.join(os.homedir(), '.bun', 'install', 'global');
const packageFile = path.join(globalDir, 'package.json');
const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
};
const installed = (name) =>
  readJson(path.join(globalDir, 'node_modules', name, 'package.json'))
    ?.version ?? null;
const manifest = readJson(packageFile);
if (!manifest?.dependencies)
  throw new Error(`No global package.json with dependencies at ${packageFile}`);

const declared = Object.keys(manifest.dependencies).sort();
const names = [
  ...new Set((PARAMS.names || []).map((n) => String(n).trim()).filter(Boolean)),
];
if (!PARAMS.all && !names.length)
  throw new Error('Pass one dependency name, or --update-all-dependencies');
for (const name of names) {
  if (!NAME.test(name)) throw new Error(`Invalid dependency name: ${name}`);
  if (!declared.includes(name))
    throw new Error(
      `${name} is not a top-level global dependency (${declared.join(', ')})`
    );
}
const selected = PARAMS.all ? declared : names;
const versions = () =>
  Object.fromEntries(
    selected.map((name) => [
      name,
      { declared: manifest.dependencies[name], installed: installed(name) },
    ])
  );
const related = () => ({
  ghUploadLog: installed('gh-upload-log'),
  sensitiveDataSanitizer: installed(
    '@link-foundation/sensitive-data-sanitizer'
  ),
  useM: installed('use-m'),
});
const before = { dependencies: versions(), related: related() };
let backup = null;
if (!PARAMS.dry) {
  backup = path.join(
    os.homedir(),
    '.hive-mind',
    'state',
    'auto-fix-dependency-backups',
    new Date().toISOString().replace(/[:.]/g, '-')
  );
  fs.mkdirSync(backup, { recursive: true, mode: 0o700 });
  for (const name of ['package.json', 'bun.lock', 'bun.lockb']) {
    const source = path.join(globalDir, name);
    if (fs.existsSync(source)) fs.copyFileSync(source, path.join(backup, name));
  }
}
const args = [
  'update',
  '-g',
  '--latest',
  ...(PARAMS.all ? [] : names),
  ...(PARAMS.dry ? ['--dry-run'] : []),
];
const result = spawnSync('bun', args, {
  cwd: os.homedir(),
  encoding: 'utf8',
  timeout: 30 * 60 * 1000,
  maxBuffer: 16 * 1024 * 1024,
  env: { ...process.env, CI: '1', NO_COLOR: '1' },
});
const current = readJson(packageFile);
const afterManifest = current?.dependencies ? current : manifest;
const after = {
  dependencies: Object.fromEntries(
    selected.map((name) => [
      name,
      {
        declared: afterManifest.dependencies[name],
        installed: installed(name),
      },
    ])
  ),
  related: related(),
};
const changed = selected
  .filter(
    (name) =>
      JSON.stringify(before.dependencies[name]) !==
      JSON.stringify(after.dependencies[name])
  )
  .map((name) => ({
    name,
    before: before.dependencies[name],
    after: after.dependencies[name],
  }));
console.log(
  'AF_JSON:' +
    JSON.stringify({
      dry: PARAMS.dry === true,
      all: PARAMS.all === true,
      command: ['bun', ...args].join(' '),
      exit: result.status,
      output: (result.stdout || '') + (result.stderr || ''),
      error: result.error?.message || null,
      backup,
      before,
      after,
      changed,
    })
);
