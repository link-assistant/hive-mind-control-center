import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'test-anywhere';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const sourceFiles = [
  'src/hive-control-center/deploy-docker.mjs',
  'src/hive-control-center/deploy-remote-docker.mjs',
  'src/hive-control-center/diagnose-mtproxy.mjs',
  'src/hive-control-center/scripts/mtproxy/api-test.mjs',
  'src/hive-control-center/scripts/mtproxy/proxy-matrix.mjs',
];
const docsFile = join(
  root,
  'src/hive-control-center/docs/MTProxy-CONFIG-COVERAGE.md'
);

const read = (file) => readFileSync(join(root, file), 'utf8');

const environmentNames = () => {
  const names = new Set();
  for (const file of sourceFiles) {
    const text = read(file);
    for (const pattern of [
      /getenv\(['"]([A-Z0-9_]+)['"]\)/g,
      /value\(['"]([A-Z0-9_]+)['"]/g,
      /process\.env\.([A-Z0-9_]+)/g,
    ]) {
      for (const match of text.matchAll(pattern)) {
        names.add(match[1]);
      }
    }
  }
  return [...names]
    .filter(
      (name) =>
        name.startsWith('MTPROXY_') ||
        name.startsWith('TELEGRAM_') ||
        ['LENV_FILE', 'SERVER_IP', 'DEPLOY_MTPROXY', 'VERIFY_MTPROXY'].includes(
          name
        )
    )
    .sort();
};

describe('MTProxy configuration coverage', () => {
  it('documents every MTProxy and Telegram environment variable', () => {
    const docs = readFileSync(docsFile, 'utf8');
    const missing = environmentNames().filter(
      (name) => !docs.includes(`\`${name}\``)
    );
    expect(missing).toEqual([]);
  });

  it('links the coverage document from verification and backlog', () => {
    expect(
      read('src/hive-control-center/docs/MTProxy-VERIFICATION.md')
    ).toContain('MTProxy-CONFIG-COVERAGE.md');
    expect(
      read('src/hive-control-center/docs/MTProxy-RESEARCH-BACKLOG.md')
    ).toContain('MTProxy-CONFIG-COVERAGE.md');
  });

  it('uses a legacy-aware MTProxy container name pattern in cleanup paths', () => {
    const pattern = '^mtproxy(-classic(-[0-9]+)?(-old)?)?$';
    for (const file of sourceFiles.filter(
      (name) => name.includes('deploy-') || name.includes('proxy-matrix')
    )) {
      expect(read(file)).toContain(pattern);
    }
    expect(read('src/hive-control-center/docs/DEPLOY.md')).toContain(
      'mtproxy-classic-<port>-old'
    );
  });
});
