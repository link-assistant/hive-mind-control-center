#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const command = args[0] ?? 'compare';
const values = {};
for (let i = 1; i < args.length; i += 1) {
  const key = args[i];
  if (!key.startsWith('--')) continue;
  values[key.slice(2)] = args[++i] ?? '';
}

const file = values.file ?? 'scripts/mtproxy/known-good.json';
const profile = JSON.parse(readFileSync(file, 'utf8'));

const normalize = (value) => String(value ?? '').trim();
const number = (value) => Number(normalize(value) || 0);
const expected = profile;

if (command === 'record') {
  const now = new Date().toISOString();
  const merge = (object, key, value) => {
    if (value === undefined || value === '') return;
    object[key] = value;
  };
  merge(expected.secret, 'sha256', values['secret-sha']);
  merge(expected.app, 'host', values['app-host']);
  merge(expected.app, 'secretSha256', values['app-secret-sha']);
  if (values['app-port']) expected.app.port = number(values['app-port']);
  if (values['app-prefix']) expected.app.secretPrefix = normalize(values['app-prefix']);
  if (values['container']) expected.container.name = normalize(values['container']);
  if (values['image']) expected.container.image = normalize(values['image']);
  if (values['network']) expected.container.networkMode = normalize(values['network']);
  if (values['restart']) expected.container.restartPolicy = normalize(values['restart']);
  if (values.mss) expected.mss.value = number(values.mss);
  if (values['mss-rules']) expected.mss.ruleCount = number(values['mss-rules']);
  expected.recordedAt = now;
  writeFileSync(file, `${JSON.stringify(expected, null, 2)}\n`);
  console.log(`KNOWN_GOOD_RECORDED=${file}`);
  console.log(`KNOWN_GOOD_RECORDED_AT=${now}`);
  process.exit(0);
}

if (command !== 'compare') {
  console.error('usage: known-good.mjs compare|record [--file path] [--flag value]...');
  process.exit(2);
}

const mismatches = [];
const passes = [];
const check = (name, ok, detail) => {
  if (ok) {
    passes.push(name);
    return;
  }
  mismatches.push(`${name}: ${detail}`);
};

check('container', !values.container || normalize(values.container) === expected.container.name, `expected ${expected.container.name}, got ${values.container}`);
check('image', !values.image || normalize(values.image) === expected.container.image, `expected ${expected.container.image}, got ${values.image}`);
check('network', !values.network || normalize(values.network) === expected.container.networkMode, `expected ${expected.container.networkMode}, got ${values.network}`);
check('restart', !values.restart || normalize(values.restart) === expected.container.restartPolicy, `expected ${expected.container.restartPolicy}, got ${values.restart}`);
check('secret', !values['secret-sha'] || normalize(values['secret-sha']) === expected.secret.sha256, 'proxy secret hash differs from known-good');
check('app-host', !values['app-host'] || normalize(values['app-host']) === expected.app.host, `expected ${expected.app.host}, got ${values['app-host']}`);
check('app-port', !values['app-port'] || number(values['app-port']) === Number(expected.app.port), `expected ${expected.app.port}, got ${values['app-port']}`);
check('app-prefix', !values['app-prefix'] || normalize(values['app-prefix']) === expected.app.secretPrefix, `expected ${expected.app.secretPrefix}, got ${values['app-prefix']}`);
check('app-secret', !values['app-secret-sha'] || normalize(values['app-secret-sha']) === expected.app.secretSha256, 'app secret hash differs from known-good');
check('mss', !values.mss || number(values.mss) === Number(expected.mss.value), `expected ${expected.mss.value}, got ${values.mss}`);
check('mss-rules', !values['mss-rules'] || number(values['mss-rules']) >= Number(expected.mss.ruleCount), `expected >=${expected.mss.ruleCount}, got ${values['mss-rules']}`);
check(
  'mss-service',
  !values['mss-service'] || normalize(values['mss-service']) === `${expected.mss.enabled},${expected.mss.active}`,
  `expected ${expected.mss.enabled},${expected.mss.active}, got ${values['mss-service']}`,
);
check('dc2-main', !values['dc2-main'] || number(values['dc2-main']) > 0, 'proxy.conf has no DC2 main line');
check('dc2-media', !values['dc2-media'] || number(values['dc2-media']) > 0, 'proxy.conf has no DC2 media line');
check('media203', !values['media203'] || number(values.media203) > 0, 'proxy.conf has no media DC203 line');

console.log(`KNOWN_GOOD_FILE=${file}`);
console.log(`KNOWN_GOOD_RECORDED_AT=${expected.recordedAt}`);
console.log(`KNOWN_GOOD_CHECKS=${passes.length}`);
console.log(`KNOWN_GOOD_MISMATCHES=${mismatches.length}`);
for (const mismatch of mismatches) console.log(`KNOWN_GOOD_MISMATCH=${mismatch}`);
console.log(`KNOWN_GOOD_STATUS=${mismatches.length === 0 ? 'PASS' : 'FAIL'}`);
process.exit(mismatches.length === 0 ? 0 : 1);
