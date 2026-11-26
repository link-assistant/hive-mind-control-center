import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
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
    for (const file of [sourceFiles[0], sourceFiles[4]]) {
      expect(read(file)).toContain(pattern);
    }
    expect(read(sourceFiles[1])).toContain(
      'await runStagedMtproxyDeploy(modeFlag, innerFlags)'
    );
    expect(read('src/hive-control-center/docs/DEPLOY.md')).toContain(
      'mtproxy-classic-<port>-old'
    );
  });
});

// The copied deployment script runs standalone. Test these functions without
// bootstrapping its remote dependencies, accessing Docker, or touching MSS.
const localDeploy = read(sourceFiles[0]);
const declaration = (name, end = '};') => {
  const start = localDeploy.indexOf(`const ${name} = `);
  const finish = localDeploy.indexOf(end === '};' ? '\n};' : end, start);
  assert.ok(start >= 0 && finish >= 0, `Missing declaration for ${name}`);
  return localDeploy.slice(start, finish + (end === '};' ? 3 : end.length));
};

function undeployFixture(listings) {
  const calls = [];
  const undeploy = runInNewContext(
    [
      declaration('MTPROXY_CONTAINER_NAME_PATTERN', ';'),
      declaration('listMtproxyContainers'),
      declaration('undeployMtproxy'),
      'undeployMtproxy',
    ].join('\n'),
    {
      capture: async (command) => {
        calls.push(command);
        return listings.shift();
      },
      run: async (command) => {
        calls.push(command);
        return { code: 0 };
      },
      removeMtproxyMss: async ({ removeFiles }) => {
        calls.push(removeFiles ? 'remove MSS hook' : 'disable MSS hook');
      },
      console: { log() {} },
    }
  );
  return { undeploy, calls };
}

describe('legacy MTProxy undeploy', () => {
  for (const temporary of [true, false]) {
    it(`checks the same scope before and after ${temporary ? 'stop' : 'remove'}`, async () => {
      const names =
        'mtproxy mtproxy-classic mtproxy-classic-443 mtproxy-classic-8443-old';
      const { undeploy, calls } = undeployFixture([
        {
          code: 0,
          stdout: `${names.replaceAll(' ', '\n')}\nhive-mind\nother-mtproxy\nmtproxy-classic-test\n`,
        },
        { code: 0, stdout: 'hive-mind\n' },
      ]);
      const list = `docker ps${temporary ? '' : ' -a'} --format '{{.Names}}'`;
      await undeploy({ temporary });
      expect(calls).toEqual([
        list,
        `docker ${temporary ? 'stop' : 'rm -f'} ${names}`,
        temporary ? 'disable MSS hook' : 'remove MSS hook',
        list,
      ]);
    });
  }

  it('fails when Docker disappears during the postcheck', async () => {
    const { undeploy } = undeployFixture([
      { code: 0, stdout: 'mtproxy-classic-443\n' },
      { code: 1, stdout: '', stderr: 'Cannot connect to the Docker daemon' },
    ]);
    await assert.rejects(undeploy(), /Could not list MTProxy containers/);
  });
});
