import { spawnSync } from 'node:child_process';
const r = spawnSync('python3', ['-c', PARAMS.source], {
  input: JSON.stringify({ act: !!PARAMS.act, tools: PARAMS.tools }),
  encoding: 'utf8', timeout: 120000, maxBuffer: 4 * 1024 * 1024,
});
if (r.status !== 0) throw new Error(`Tool service check failed: ${(r.stderr || r.error?.message || 'python3 failed').slice(-1200)}`);
console.log('AF_JSON:' + JSON.stringify(JSON.parse(r.stdout)));
