import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const release = '2.48.0';
const packageName = '@link-assistant/hive-mind';

export async function inspectTaskSnapshot(file) {
  const input = await readFile(file, 'utf8');
  let executions;
  try {
    ({ executions } = JSON.parse(input) ?? {});
  } catch {
    throw new Error('Expected a JSON file containing start-command records.');
  }
  if (!Array.isArray(executions) || executions.some((task) => typeof task?.uuid !== 'string' || !task.uuid)) {
    throw new Error('Expected start-command JSON with an executions array of records containing UUIDs.');
  }

  const prefix = resolve(process.env.HIVE_MANAGER_PREFIX || resolve(homedir(), '.local', `hive-manager-${release}`));
  const require = createRequire(resolve(prefix, 'package.json'));
  const manifest = resolve(prefix, 'node_modules', packageName, 'package.json');
  let version;
  try {
    ({ version } = JSON.parse(await readFile(manifest, 'utf8')));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    throw new Error(`Install ${packageName}@${release} in ${prefix}.`);
  }
  if (version !== release) throw new Error(`Expected Hive Mind ${release} in ${prefix}, found ${version}.`);

  const api = pathToFileURL(require.resolve(`${packageName}/hive-manager`));
  const { inspectTasks, groupTaskFailures } = await import(api.href);
  return { ...inspectTasks(executions), ...groupTaskFailures(executions) };
}
