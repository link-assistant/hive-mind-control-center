import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import vm from 'node:vm';
import test from 'node:test';

const exec = promisify(execFile);
const source = await fs.readFile(new URL('../auto-fix.mjs', import.meta.url), 'utf8');
const start = source.indexOf('const hostModule = async');
assert.ok(start >= 0);
const end = source.indexOf('\n};', start) + 3;
assert.ok(end > start);
const helper = source.slice(start, end).replace('const hostModule =', 'globalThis.hostModule =');

async function fixture(t) {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'auto-fix-host-race-'));
  t.after(() => fs.rm(scratch, { recursive: true, force: true }));
  const context = vm.createContext({
    VERBOSE: false,
    b64: (text) => Buffer.from(text).toString('base64'),
    ssh: async (command) => {
      // Both calls finish their upload before either starts Node, reproducing
      // the real shared-module race without a network connection.
      const local = command.replaceAll('/root/auto-fix', scratch)
        .replace('&& node ', '&& sleep 0.2 && node ');
      const result = await exec('bash', ['-c', local], { timeout: 5000 });
      return { stdout: result.stdout, stderr: result.stderr };
    },
  });
  new vm.Script(helper).runInContext(context);
  return { invoke: context.hostModule, scratch };
}

test('concurrent host modules execute their own source and parameters', async (t) => {
  const { invoke } = await fixture(t);
  const code = (kind) => `console.log('AF_JSON:' + JSON.stringify({ kind: '${kind}', value: PARAMS.value }));`;
  const results = await Promise.all([
    invoke(code('diagnosis'), { value: 'alpha' }),
    invoke(code('baseline'), { value: 'beta' }),
  ]);
  assert.equal(results[0].kind, 'diagnosis');
  assert.equal(results[0].value, 'alpha');
  assert.equal(results[1].kind, 'baseline');
  assert.equal(results[1].value, 'beta');
});

test('host modules remove their own scratch after success and failure', async (t) => {
  const { invoke, scratch } = await fixture(t);
  await invoke("console.log('AF_JSON:{}');");
  await assert.rejects(invoke("throw new Error('synthetic failure');"));
  assert.deepEqual(await fs.readdir(scratch), []);
});
