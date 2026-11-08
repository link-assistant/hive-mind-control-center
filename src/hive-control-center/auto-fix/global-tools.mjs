// Host-side bridge. Python's standard-library TOML parser avoids rewriting
// configuration with regexes or installing/running any untrusted add-on.
import { spawnSync } from 'node:child_process';

const result = spawnSync('python3', ['-c', PARAMS.source], {
  input: JSON.stringify({ act: !!PARAMS.act }),
  encoding: 'utf8', timeout: 180000, maxBuffer: 8 * 1024 * 1024,
});
if (result.status !== 0) {
  throw new Error(`Global tool baseline failed: ${(result.stderr || result.error?.message || 'python3 failed').slice(-1800)}`);
}
console.log('AF_JSON:' + JSON.stringify(JSON.parse(result.stdout)));
