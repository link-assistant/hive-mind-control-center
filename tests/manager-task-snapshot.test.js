import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe } from 'test-anywhere';
import { itUnless, sandboxed } from './helpers/skip.js';
import { inspectTaskSnapshot } from '../src/hive-control-center/scripts/manager-task-snapshot.mjs';

describe('saved task inspection', () => {
  itUnless(sandboxed)('uses the pinned public manager export', async () => {
    const prefix = await mkdtemp(join(tmpdir(), 'manager-snapshot-'));
    const previous = process.env.HIVE_MANAGER_PREFIX;
    process.env.HIVE_MANAGER_PREFIX = prefix;
    try {
      const file = join(prefix, 'tasks.json');
      await writeFile(file, '{ private fixture text');
      await assert.rejects(() => inspectTaskSnapshot(file), {
        message: 'Expected a JSON file containing start-command records.',
      });
      await writeFile(file, '{"executions":[null]}');
      await assert.rejects(
        () => inspectTaskSnapshot(file),
        /records containing UUIDs/
      );
      const tasks = [{ uuid: 'fixture', status: 'executing' }];
      await writeFile(file, JSON.stringify({ executions: tasks }));
      await assert.rejects(
        () => inspectTaskSnapshot(file),
        /Install .*@2\.48\.0/
      );

      const pkg = join(prefix, 'node_modules', '@link-assistant', 'hive-mind');
      await mkdir(pkg, { recursive: true });
      const manifest = join(pkg, 'package.json');
      const exports = { './hive-manager': './manager.mjs' };
      await writeFile(manifest, JSON.stringify({ version: '2.45.0', exports }));
      await assert.rejects(() => inspectTaskSnapshot(file), /found 2\.45\.0/);

      await writeFile(manifest, JSON.stringify({ version: '2.48.0', exports }));
      await writeFile(
        join(pkg, 'manager.mjs'),
        'export const inspectTasks = (tasks) => ({ counts: { running: tasks.length } });\n' +
          'export const groupTaskFailures = (tasks) => ({ groups: [tasks[0].uuid] });\n'
      );
      assert.deepEqual(await inspectTaskSnapshot(file), {
        counts: { running: 1 },
        groups: ['fixture'],
      });
    } finally {
      if (previous === undefined) {
        delete process.env.HIVE_MANAGER_PREFIX;
      } else {
        process.env.HIVE_MANAGER_PREFIX = previous;
      }
      await rm(prefix, { recursive: true, force: true });
    }
  });
});
