#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = resolve(SCRIPT_DIR, '../..');
const DEFAULT_OUT_DIR = join(ROOT_DIR, 'data', 'mtproxy-matrix');
const DEPLOY_SCRIPT = join(ROOT_DIR, 'deploy-remote-docker.mjs');
const API_SCRIPT = join(SCRIPT_DIR, 'api-test.mjs');

export const BUILTIN_CONFIGS = Object.freeze([
  {
    id: 'direct',
    label: 'Direct control (no proxy)',
    noProxy: true,
    tests: ['text'],
    notes:
      'Bypasses the proxy; establishes whether Telegram itself is reachable.',
  },
  {
    id: 'classic-baseline',
    label: 'Classic known-good',
    engine: 'classic',
    port: '443',
    workers: '4',
    mss: '1200',
    tests: ['text', 'media'],
    preferred: true,
    notes: 'Production baseline recorded in known-good.json.',
  },
  {
    id: 'classic-workers-2',
    label: 'Classic workers=2',
    engine: 'classic',
    port: '443',
    workers: '2',
    mss: '1200',
    tests: ['text'],
  },
  {
    id: 'classic-workers-6',
    label: 'Classic workers=6',
    engine: 'classic',
    port: '443',
    workers: '6',
    mss: '1200',
    tests: ['text'],
  },
  {
    id: 'classic-mss-1024',
    label: 'Classic MSS=1024',
    engine: 'classic',
    port: '443',
    workers: '4',
    mss: '1024',
    tests: ['text'],
  },
  {
    id: 'classic-mss-1300',
    label: 'Classic MSS=1300',
    engine: 'classic',
    port: '443',
    workers: '4',
    mss: '1300',
    tests: ['text'],
  },
  {
    id: 'classic-port-8443',
    label: 'Classic port=8443',
    engine: 'classic',
    port: '8443',
    workers: '4',
    mss: '1200',
    tests: ['text'],
  },
  {
    id: 'classic-beta-image',
    label: 'Classic 2.0beta image',
    engine: 'classic',
    port: '443',
    workers: '4',
    mss: '1200',
    classicImage: 'telegrammessenger/proxy:2.0beta',
    tests: ['text'],
  },
  {
    id: 'mtg-contabo',
    label: 'mtg FakeTLS contabo.com',
    engine: 'mtg',
    port: '443',
    mss: '1200',
    frontingHost: 'contabo.com',
    tests: ['text'],
  },
  {
    id: 'mtg-google',
    label: 'mtg FakeTLS www.google.com',
    engine: 'mtg',
    port: '443',
    mss: '1200',
    frontingHost: 'www.google.com',
    tests: ['text'],
  },
  {
    id: 'mtg-vk',
    label: 'mtg FakeTLS vk.com',
    engine: 'mtg',
    port: '443',
    mss: '1200',
    frontingHost: 'vk.com',
    tests: ['text'],
  },
]);

export const BASELINE_ID = 'classic-baseline';
const TEST_NAMES = new Set(['text', 'media', 'photo']);

const trim = (value) =>
  String(value ?? '')
    .trim()
    .replace(/^['"]|['"]$/g, '');

export const parseLenv = (file) => {
  const values = {};
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z0-9_]+)\s*[:=]\s*(.*?)\s*$/);
    if (!match || match[2].startsWith('#')) continue;
    values[match[1]] = trim(match[2]);
  }
  return values;
};

export const normalizeConfig = (raw, index = 0) => {
  if (!raw || typeof raw !== 'object') {
    throw new Error(`config #${index + 1} must be an object`);
  }
  const id = trim(raw.id);
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) {
    throw new Error(
      `invalid config id "${id}" (use lowercase letters, digits, hyphens)`
    );
  }
  const noProxy = raw.noProxy === true;
  const engine = noProxy
    ? 'direct'
    : trim(raw.engine || 'classic').toLowerCase();
  if (!noProxy && !['classic', 'mtg'].includes(engine)) {
    throw new Error(`config ${id}: engine must be classic or mtg`);
  }
  const port = trim(raw.port || '443');
  if (
    !noProxy &&
    (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535)
  ) {
    throw new Error(`config ${id}: invalid port ${port}`);
  }
  const workers = trim(raw.workers || '4');
  if (
    !noProxy &&
    (!/^\d+$/.test(workers) || Number(workers) < 1 || Number(workers) > 6)
  ) {
    throw new Error(`config ${id}: workers must be 1-6`);
  }
  const mss = trim(raw.mss || '1200');
  if (
    !noProxy &&
    (!/^\d+$/.test(mss) || Number(mss) < 536 || Number(mss) > 1460)
  ) {
    throw new Error(`config ${id}: mss must be 536-1460`);
  }
  const tests = (raw.tests || ['text']).map((test) => trim(test).toLowerCase());
  if (!tests.length || tests.some((test) => !TEST_NAMES.has(test))) {
    throw new Error(`config ${id}: tests must include text, media, or photo`);
  }
  return {
    id,
    label: trim(raw.label || id),
    engine,
    port,
    workers,
    mss,
    classicImage: trim(raw.classicImage || ''),
    image: trim(raw.image || ''),
    frontingHost: trim(raw.frontingHost || ''),
    noProxy,
    tests: [...new Set(tests)],
    preferred: raw.preferred === true,
    notes: trim(raw.notes || ''),
    order: index,
  };
};

export const buildDeployArgs = (config) => {
  if (config.noProxy) return [];
  const args = [
    '--mtproxy-only',
    '--mtproxy-update',
    '--mtproxy-engine',
    config.engine,
    '--mtproxy-port',
    config.port,
    '--mtproxy-mss',
    config.mss,
    '--mtproxy-workers',
    config.workers,
  ];
  if (config.classicImage) {
    args.push('--mtproxy-classic-image', config.classicImage);
  }
  if (config.image) args.push('--mtproxy-image', config.image);
  if (config.frontingHost) {
    args.push('--mtproxy-fronting-host', config.frontingHost);
  }
  return args;
};

export const buildApiArgs = ({
  config,
  lenvFile,
  telegramEnv,
  secretFile = '',
  sessionFile = '',
}) => {
  const args = [
    '--host',
    trim(parseLenv(lenvFile).SERVER_IP || ''),
    '--port',
    config.port,
    '--lenv',
    lenvFile,
    '--env-file',
    telegramEnv,
  ];
  if (sessionFile) args.push('--session-file', sessionFile);
  if (config.noProxy) args.push('--no-proxy');
  else args.push('--secret-file', secretFile);
  if (config.tests.includes('media')) args.push('--media');
  if (config.tests.includes('photo')) args.push('--roundtrip-photo');
  if (config.tests.includes('media') || config.tests.includes('photo')) {
    args.push('--relax-ping');
  }
  return args;
};

export const parseClassicSecret = (output) => {
  const first =
    String(output || '')
      .trim()
      .split(/\s+/)[0] || '';
  const secret = first.replace(/^dd/i, '').toLowerCase();
  return /^[0-9a-f]{32}$/.test(secret) ? secret : '';
};

export const parseMtgSecret = (output) => {
  const match = String(output || '').match(/[?&]secret=([^&\s]+)/i);
  if (!match) return '';
  let secret = match[1];
  try {
    secret = decodeURIComponent(secret);
  } catch {}
  return /^ee[0-9a-f]{32,}$/i.test(secret) ? secret.toLowerCase() : '';
};

export const extractSecret = (engine, output) =>
  engine === 'mtg' ? parseMtgSecret(output) : parseClassicSecret(output);

export const classifyApi = (output) => {
  const text = String(output || '');
  const status = text.match(/^API_TEST_STATUS=(PASS|FAIL)$/m)?.[1] || '';
  const error = text.match(/^API_TEST_ERROR=(.*)$/m)?.[1]?.trim() || '';
  const media = /^API_TEST_MEDIA_DOWNLOADED=yes\b.*\bverified=yes\b/m.test(
    text
  );
  const photo = /^API_TEST_PHOTO_DOWNLOADED=yes\b.*\bverified=yes\b/m.test(
    text
  );
  const sent = /^API_TEST_SENT=yes\b.*\bsaved_messages_verified=yes\b/m.test(
    text
  );
  const pass = status === 'PASS';
  return {
    status,
    error,
    sent,
    text: pass && (sent || media || photo),
    media,
    photo,
  };
};

export const scoreResult = (result) => {
  if (!result.deploy.ok || !result.api.attempted) return -1;
  if (!result.api.text) return 0;
  let score = 1;
  if (result.api.media) score += 5;
  if (result.api.photo) score += 1;
  return score;
};

export const selectBest = (results) => {
  const eligible = results
    .filter(
      (result) =>
        !result.config.noProxy &&
        result.deploy.ok &&
        result.api.attempted &&
        result.api.text
    )
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (Number(b.config.preferred) !== Number(a.config.preferred)) {
        return Number(b.config.preferred) - Number(a.config.preferred);
      }
      if (a.api.durationMs !== b.api.durationMs) {
        return a.api.durationMs - b.api.durationMs;
      }
      return a.config.order - b.config.order;
    });
  return eligible[0] || null;
};

export const redact = (value) =>
  String(value || '')
    .replace(/([?&]secret=)[^&\s]+/gi, '$1[redacted]')
    .replace(/\b[0-9a-f]{32,}\b/gi, '[redacted]');

const tailLines = (value, count = 12) => {
  const lines = redact(value).trim().split(/\r?\n/).filter(Boolean);
  return lines.slice(-count).join('\n');
};

const publicIp = (timeout) => {
  const result = spawnSync(
    'curl',
    ['-4', '-fsS', '--max-time', '5', 'https://api.ipify.org'],
    { encoding: 'utf8', timeout }
  );
  return result.status === 0 ? trim(result.stdout) : '';
};

const routeFor = (host) => {
  const result = spawnSync('route', ['-n', 'get', host], {
    encoding: 'utf8',
    timeout: 5000,
  });
  return {
    interface: result.stdout?.match(/interface:\s*(\S+)/)?.[1] || '',
    gateway: result.stdout?.match(/gateway:\s*(\S+)/)?.[1] || '',
  };
};

const run = (
  command,
  args,
  { cwd = ROOT_DIR, env = {}, timeout = 60000 } = {}
) => {
  const started = Date.now();
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...env },
    maxBuffer: 32 * 1024 * 1024,
    timeout,
  });
  return {
    ok: result.status === 0,
    status: result.status,
    signal: result.signal || '',
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    error: result.error?.message || '',
    timedOut: result.error?.code === 'ETIMEDOUT',
    durationMs: Date.now() - started,
  };
};

const sshExec = (lenv, command, timeout) => {
  const serverIp = trim(lenv.SERVER_IP);
  const serverUser = trim(lenv.SERVER_USER || 'root');
  if (!serverIp || !lenv.SERVER_PASS) {
    return {
      ok: false,
      status: null,
      stdout: '',
      stderr: 'SERVER_IP/SERVER_PASS missing from .lenv',
      error: 'missing credentials',
      timedOut: false,
      durationMs: 0,
    };
  }
  return run(
    'sshpass',
    [
      '-e',
      'ssh',
      '-4',
      '-o',
      'StrictHostKeyChecking=no',
      '-o',
      'UserKnownHostsFile=/dev/null',
      '-o',
      'ConnectTimeout=10',
      '-o',
      'ServerAliveInterval=5',
      '-o',
      'ServerAliveCountMax=2',
      '-o',
      'PubkeyAuthentication=no',
      '-o',
      'PreferredAuthentications=password',
      '-o',
      'NumberOfPasswordPrompts=1',
      '-o',
      'LogLevel=ERROR',
      `${serverUser}@${serverIp}`,
      command,
    ],
    { env: { SSHPASS: lenv.SERVER_PASS }, timeout }
  );
};

export const containerName = (config) => {
  if (config.noProxy) return '';
  return config.engine === 'mtg' ? 'mtproxy' : `mtproxy-classic-${config.port}`;
};

const secretPath = (config) =>
  config.engine === 'mtg'
    ? '/root/.hive-mtproxy/link.txt'
    : `/root/.hive-mtproxy-classic-${config.port}/secret`;

const renderConfigTable = (configs) => {
  const rows = configs.map(
    (config, index) =>
      `| ${index + 1} | ${config.id} | ${config.label} | ${config.noProxy ? 'direct' : `${config.engine}/${config.port}`} | ${config.noProxy ? '-' : `${config.workers}/${config.mss}`} | ${config.tests.join(', ')} |`
  );
  return [
    '| # | id | label | engine/port | workers/MSS | tests |',
    '| --- | --- | --- | --- | --- | --- |',
    ...rows,
  ].join('\n');
};

export const renderMarkdown = (summary) => {
  const lines = [
    `# MTProxy configuration matrix — ${summary.startedAt}`,
    '',
    `- Public IP: ${summary.network.publicIp || 'unknown'}`,
    `- Interface/gateway: ${summary.network.interface || 'unknown'} / ${summary.network.gateway || 'unknown'}`,
    `- Preflight: ${summary.preflight.ok ? 'PASS' : 'BLOCKED'}${summary.preflight.error ? ` — ${summary.preflight.error}` : ''}`,
    `- Selected: ${summary.selected.id || 'none'} (${summary.selected.reason})`,
    '',
    '| # | config | engine/port | deploy | text | media | photo | API | time | verdict |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...summary.results.map((result, index) => {
      const cell = (value, requested) =>
        !requested
          ? '-'
          : value
            ? 'PASS'
            : result.api.attempted
              ? 'FAIL'
              : 'SKIP';
      return `| ${index + 1} | ${result.config.id} | ${result.config.noProxy ? 'direct' : `${result.config.engine}/${result.config.port}`} | ${result.verdict === 'BLOCKED' ? 'BLOCKED' : result.deploy.ok ? 'PASS' : result.deploy.attempted ? 'FAIL' : 'SKIP'} | ${cell(result.api.text, true)} | ${cell(result.api.media, result.config.tests.includes('media'))} | ${cell(result.api.photo, result.config.tests.includes('photo'))} | ${result.api.status || 'SKIP'} | ${Math.round((result.deploy.durationMs + result.api.durationMs) / 1000)}s | ${result.verdict} |`;
    }),
    '',
    '`media` includes the document and photo checks performed by `--media`; `photo` is the explicit `--roundtrip-photo` check.',
    '',
    '## Selected configuration',
    '',
    summary.selected.detail || 'No configuration passed.',
    '',
    '## Failures',
    '',
    ...(summary.results.filter((result) => result.verdict !== 'PASS').length
      ? summary.results
          .filter((result) => result.verdict !== 'PASS')
          .map(
            (result) =>
              `### ${result.config.id}\n\n- verdict: ${result.verdict}\n- deploy: ${result.deploy.ok ? 'PASS' : result.deploy.error || result.deploy.status}\n- api: ${result.api.error || result.api.status || 'not run'}\n${result.deploy.tail ? `\n\`\`\`\n${result.deploy.tail}\n\`\`\`\n` : ''}`
          )
      : ['All attempted configurations passed.']),
  ];
  return `${lines.join('\n')}\n`;
};

const cleanupExistingProxies = (lenv, timeout) =>
  sshExec(
    lenv,
    "docker ps -a --format '{{.Names}}' | grep -E '^mtproxy(-classic-[0-9]+)?$' | xargs -r docker rm -f",
    timeout
  );

const deployConfig = (config, timeout, lenv, sshTimeout) => {
  if (config.noProxy) {
    return {
      attempted: false,
      ok: true,
      status: 0,
      durationMs: 0,
      stdout: '',
      stderr: '',
      error: '',
      tail: '',
      timedOut: false,
    };
  }
  const preclean = cleanupExistingProxies(lenv, sshTimeout);
  if (!preclean.ok) {
    return {
      ...preclean,
      attempted: true,
      error:
        preclean.stderr.trim() ||
        preclean.error ||
        'could not remove existing proxy containers before redeploy',
      tail: tailLines(`${preclean.stderr}\n${preclean.stdout}`),
    };
  }
  const result = run(
    process.execPath,
    [DEPLOY_SCRIPT, ...buildDeployArgs(config)],
    {
      timeout,
    }
  );
  return {
    ...result,
    attempted: true,
    tail: tailLines(`${result.stderr}\n${result.stdout}`),
  };
};

const fetchSecret = (config, lenv, timeout) => {
  const result = sshExec(lenv, `cat ${secretPath(config)}`, timeout);
  const secret = extractSecret(
    config.engine,
    `${result.stdout}\n${result.stderr}`
  );
  return {
    ok: Boolean(secret),
    secret,
    error: secret
      ? ''
      : result.timedOut
        ? 'SSH timed out while reading the proxy secret'
        : result.stderr.trim() || result.error || 'secret not found',
  };
};

const runApi = ({
  config,
  lenvFile,
  telegramEnv,
  sessionFile,
  secret,
  timeout,
}) => {
  const tempDir = mkdtempSync(join(tmpdir(), 'mtproxy-matrix-'));
  const secretFile = join(tempDir, 'secret');
  try {
    if (!config.noProxy) writeFileSync(secretFile, secret, { mode: 0o600 });
    const result = run(
      process.execPath,
      [
        API_SCRIPT,
        ...buildApiArgs({
          config,
          lenvFile,
          telegramEnv,
          secretFile,
          sessionFile,
        }),
      ],
      { timeout }
    );
    const output = `${result.stdout}\n${result.stderr}`;
    return {
      ...result,
      attempted: true,
      ...classifyApi(output),
      lines: output
        .split(/\r?\n/)
        .filter((line) => /^API_TEST_|^Error:|^Error\b/.test(line))
        .map(redact)
        .slice(-20),
    };
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
};

const resultVerdict = (result) => {
  if (!result.deploy.ok) return 'FAIL';
  if (!result.api.attempted) return 'SKIP';
  if (result.api.status === 'PASS' && result.api.text) return 'PASS';
  if (result.api.text) return 'PARTIAL';
  return 'FAIL';
};

const cleanupProxies = (results, selected, lenv, timeout) => {
  const keep = selected ? containerName(selected) : '';
  const names = [
    ...new Set(
      results
        .filter((result) => result.deploy.ok && !result.config.noProxy)
        .map((result) => containerName(result.config))
        .filter((name) => name && name !== keep)
    ),
  ];
  const removed = [];
  for (const name of names) {
    const result = sshExec(lenv, `docker rm -f ${name}`, timeout);
    removed.push({
      name,
      ok: result.ok,
      error: result.ok ? '' : result.stderr.trim(),
    });
  }
  return { kept: keep, removed };
};

const keepConfiguration = ({
  winner,
  fallback,
  results,
  lenv,
  timeout,
  sshTimeout,
  cleanup,
}) => {
  const selected = winner || fallback;
  if (!selected) {
    return {
      id: '',
      reason: 'no configuration to keep',
      detail: 'No configuration passed and no fallback was available.',
      kept: false,
    };
  }
  const reason = winner
    ? `best score ${winner.score}`
    : 'no configuration passed; restored baseline';
  const deploy = deployConfig(selected, timeout, lenv, sshTimeout);
  const cleanupResult =
    cleanup && deploy.ok
      ? cleanupProxies(results, selected, lenv, sshTimeout)
      : { kept: containerName(selected), removed: [] };
  return {
    id: selected.id,
    reason,
    kept: deploy.ok,
    detail: [
      `Selected \`${selected.id}\` (${reason}) and left it on the server.`,
      `Redeployed ${selected.noProxy ? 'no proxy' : `${selected.engine}/${selected.port}`} after testing.`,
      deploy.ok ? '' : `Final deploy failed: ${deploy.error || deploy.status}`,
      cleanupResult.removed.length
        ? `Removed other matrix containers: ${cleanupResult.removed.map((item) => item.name).join(', ')}.`
        : 'No other matrix containers needed removal.',
    ]
      .filter(Boolean)
      .join(' '),
    deploy,
    cleanup: cleanupResult,
  };
};

const parseList = (value) =>
  String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

const writeSummary = (summary, outDir) => {
  mkdirSync(outDir, { recursive: true });
  const stamp = summary.startedAt.replace(/[:.]/g, '-');
  const jsonFile = join(outDir, `mtproxy-matrix-${stamp}.json`);
  const mdFile = join(outDir, `mtproxy-matrix-${stamp}.md`);
  writeFileSync(jsonFile, `${JSON.stringify(summary, null, 2)}\n`);
  writeFileSync(mdFile, renderMarkdown(summary));
  return { jsonFile, mdFile };
};

const printTable = (summary) => {
  console.log('\n| # | config | deploy | text | media | photo | verdict |');
  console.log('| --- | --- | --- | --- | --- | --- | --- |');
  summary.results.forEach((result, index) => {
    const cell = (value, requested) =>
      !requested
        ? '-'
        : value
          ? 'PASS'
          : result.api.attempted
            ? 'FAIL'
            : 'SKIP';
    console.log(
      `| ${index + 1} | ${result.config.id} | ${result.verdict === 'BLOCKED' ? 'BLOCKED' : result.deploy.ok ? 'PASS' : 'FAIL'} | ${cell(result.api.text, true)} | ${cell(result.api.media, result.config.tests.includes('media'))} | ${cell(result.api.photo, result.config.tests.includes('photo'))} | ${result.verdict} |`
    );
  });
};

const parseArgs = (argv) => {
  const options = {
    list: false,
    dryRun: false,
    keepBest: true,
    cleanup: true,
    lenvFile: join(ROOT_DIR, '.lenv'),
    telegramEnv: process.env.TELEGRAM_ENV_FILE || '',
    sessionFile: process.env.TELEGRAM_SESSION_FILE || '',
    configFile: '',
    only: [],
    skip: [],
    tests: [],
    outDir: DEFAULT_OUT_DIR,
    deployTimeout: 15 * 60 * 1000,
    apiTimeout: 3 * 60 * 1000,
    sshTimeout: 20 * 1000,
  };
  const next = (arg) => {
    const value = argv[++options.index];
    if (value === undefined) throw new Error(`missing value for ${arg}`);
    return value;
  };
  options.index = 0;
  while (options.index < argv.length) {
    const arg = argv[options.index];
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--list') options.list = true;
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--no-keep-best') options.keepBest = false;
    else if (arg === '--no-cleanup') options.cleanup = false;
    else if (arg === '--lenv') options.lenvFile = resolve(next(arg));
    else if (arg === '--telegram-env') options.telegramEnv = resolve(next(arg));
    else if (arg === '--session-file') options.sessionFile = resolve(next(arg));
    else if (arg === '--config') options.configFile = resolve(next(arg));
    else if (arg === '--only') options.only = parseList(next(arg));
    else if (arg === '--skip') options.skip = parseList(next(arg));
    else if (arg === '--tests') options.tests = parseList(next(arg));
    else if (arg === '--out') options.outDir = resolve(next(arg));
    else if (arg === '--deploy-timeout')
      options.deployTimeout = Number(next(arg));
    else if (arg === '--api-timeout') options.apiTimeout = Number(next(arg));
    else if (arg === '--ssh-timeout') options.sshTimeout = Number(next(arg));
    else throw new Error(`unknown option: ${arg}`);
    options.index += 1;
  }
  return options;
};

const help = `Usage: node scripts/mtproxy/proxy-matrix.mjs [options]

Redeploys the MTProxy container in proxy-only mode before every configuration,
tests each one from this network, writes JSON/Markdown summaries, then selects
and keeps the best configuration on the server.

Options:
  --list                    List built-in configurations and exit
  --dry-run                 Print deploy/test commands without changing the server
  --config <file>           JSON array of custom configurations (replaces built-ins)
  --only <ids>              Comma-separated configuration ids to run
  --skip <ids>              Comma-separated configuration ids to skip
  --tests <names>           Override tests for every config: text,media,photo
  --telegram-env <path>     Telegram API credentials (default TELEGRAM_ENV_FILE)
  --session-file <path>     Telegram session file (optional; inferred by api-test)
  --lenv <path>             Server credentials/config (default ./.lenv)
  --out <dir>               Summary directory (default data/mtproxy-matrix)
  --deploy-timeout <ms>     Per-config deploy timeout (default 900000)
  --api-timeout <ms>        Per-config API test timeout (default 180000)
  --ssh-timeout <ms>        SSH preflight/secret/cleanup timeout (default 20000)
  --no-keep-best            Leave the last tested configuration instead of selecting
  --no-cleanup              Do not remove other matrix-created proxy containers
  -h, --help                Show this help

The script never prints or stores proxy secrets. It uses the persisted secret on
the server and a mode-0600 temporary file for the API test. Requires sshpass.
`;

const loadConfigs = (options) => {
  let configs;
  if (options.configFile) {
    const parsed = JSON.parse(readFileSync(options.configFile, 'utf8'));
    if (!Array.isArray(parsed))
      throw new Error('custom config must be a JSON array');
    configs = parsed.map(normalizeConfig);
  } else {
    configs = BUILTIN_CONFIGS.map(normalizeConfig);
  }
  if (options.only.length) {
    const known = new Set(configs.map((config) => config.id));
    const missing = options.only.filter((id) => !known.has(id));
    if (missing.length)
      throw new Error(`unknown --only ids: ${missing.join(', ')}`);
    configs = configs.filter((config) => options.only.includes(config.id));
  }
  if (options.skip.length) {
    configs = configs.filter((config) => !options.skip.includes(config.id));
  }
  if (!configs.length) throw new Error('no configurations selected');
  return configs;
};

const main = async () => {
  const options = parseArgs(process.argv.slice(2));
  for (const key of ['deployTimeout', 'apiTimeout', 'sshTimeout']) {
    if (!Number.isFinite(options[key]) || options[key] < 1000) {
      throw new Error(
        `invalid --${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`
      );
    }
  }
  if (options.help) {
    console.log(help);
    return;
  }
  const configs = loadConfigs(options);
  if (options.tests.length) {
    if (options.tests.some((test) => !TEST_NAMES.has(test))) {
      throw new Error(`invalid --tests: ${options.tests.join(', ')}`);
    }
    for (const config of configs) config.tests = [...new Set(options.tests)];
  }
  if (options.list) {
    console.log(renderConfigTable(configs));
    return;
  }
  if (options.dryRun) {
    for (const config of configs) {
      console.log(`# ${config.id}`);
      console.log(
        config.noProxy
          ? 'node scripts/mtproxy/api-test.mjs ... --no-proxy'
          : `node deploy-remote-docker.mjs ${buildDeployArgs(config).join(' ')}`
      );
    }
    return;
  }
  if (!options.telegramEnv || !existsSync(options.telegramEnv)) {
    throw new Error(
      '--telegram-env or TELEGRAM_ENV_FILE must point to Telegram API credentials'
    );
  }
  if (!existsSync(options.lenvFile)) {
    throw new Error(`cannot read ${options.lenvFile}`);
  }
  const lenv = parseLenv(options.lenvFile);
  const needsDeploy = configs.some((config) => !config.noProxy);
  const startedAt = new Date().toISOString();
  const network = {
    publicIp: publicIp(7000),
    ...routeFor(trim(lenv.SERVER_IP)),
  };
  const summary = {
    schema: 1,
    startedAt,
    finishedAt: '',
    network,
    preflight: { ok: true, error: '' },
    results: [],
    selected: { id: '', reason: 'not selected yet', detail: '', kept: false },
  };
  if (needsDeploy) {
    const preflight = sshExec(lenv, 'echo MATRIX_SSH_OK', options.sshTimeout);
    const marker = preflight.stdout.includes('MATRIX_SSH_OK');
    summary.preflight = {
      ok: preflight.ok && marker,
      error:
        preflight.ok && marker
          ? ''
          : preflight.timedOut
            ? 'SSH timed out during preflight'
            : preflight.stderr.trim() ||
              preflight.error ||
              `SSH preflight failed (status=${preflight.status}, signal=${preflight.signal || 'none'}, marker=${marker})`,
    };
  }
  if (!summary.preflight.ok) {
    summary.selected = {
      id: '',
      reason: 'preflight blocked; no configuration was deployed',
      detail: `No deploy was attempted because SSH preflight failed: ${summary.preflight.error}`,
      kept: false,
    };
    summary.results = configs.map((config) => ({
      config,
      deploy: {
        attempted: false,
        ok: false,
        status: null,
        durationMs: 0,
        error: summary.preflight.error,
        tail: '',
        timedOut: false,
      },
      api: {
        attempted: false,
        status: '',
        text: false,
        media: false,
        photo: false,
        error: '',
        durationMs: 0,
        lines: [],
      },
      score: -1,
      verdict: 'BLOCKED',
    }));
  } else {
    let lastDeployedId = '';
    for (const config of configs) {
      console.log(`\n>>> ${config.id}: ${config.label}`);
      const deploy = deployConfig(
        config,
        options.deployTimeout,
        lenv,
        options.sshTimeout
      );
      if (deploy.attempted) {
        console.log(deploy.ok ? 'deploy: PASS' : 'deploy: FAIL');
        if (!deploy.ok && deploy.tail) console.log(deploy.tail);
      }
      if (deploy.attempted && deploy.ok) lastDeployedId = config.id;
      let secret = '';
      let secretError = '';
      let api = {
        attempted: false,
        status: '',
        text: false,
        media: false,
        photo: false,
        error: '',
        durationMs: 0,
        lines: [],
      };
      if (!deploy.ok) {
        secretError = 'skipped because deploy failed';
      } else if (!config.noProxy) {
        const fetched = fetchSecret(config, lenv, options.sshTimeout);
        secret = fetched.secret;
        secretError = fetched.error;
      }
      if (deploy.ok && (config.noProxy || secret)) {
        api = runApi({
          config,
          lenvFile: options.lenvFile,
          telegramEnv: options.telegramEnv,
          sessionFile: options.sessionFile,
          secret,
          timeout: options.apiTimeout,
        });
        console.log(
          `api: ${api.status || 'NO STATUS'} text=${api.text} media=${api.media} photo=${api.photo}`
        );
        if (api.lines.length) console.log(api.lines.join('\n'));
      } else if (deploy.ok) {
        api.error = secretError;
      }
      const result = {
        config,
        deploy,
        secret: { found: Boolean(secret), error: secretError },
        api,
        score: -1,
        verdict: 'FAIL',
      };
      result.score = scoreResult(result);
      result.verdict = resultVerdict(result);
      summary.results.push(result);
    }
    const winner = selectBest(summary.results);
    const fallback =
      configs.find((config) => config.id === BASELINE_ID) ||
      normalizeConfig(
        BUILTIN_CONFIGS.find((config) => config.id === BASELINE_ID),
        1
      );
    summary.selected = !needsDeploy
      ? {
          id: '',
          reason: 'no proxy configurations selected',
          detail:
            'Only direct/no-proxy configurations were selected; nothing was deployed.',
          kept: false,
        }
      : options.keepBest
        ? keepConfiguration({
            winner,
            fallback,
            results: summary.results,
            lenv,
            timeout: options.deployTimeout,
            sshTimeout: options.sshTimeout,
            cleanup: options.cleanup,
          })
        : {
            id: lastDeployedId,
            reason: '--no-keep-best; left the last tested configuration',
            detail: `Left \`${lastDeployedId || 'none'}\` on the server.`,
            kept: Boolean(lastDeployedId),
          };
  }
  summary.finishedAt = new Date().toISOString();
  const files = writeSummary(summary, options.outDir);
  printTable(summary);
  console.log(
    `\nSelected: ${summary.selected.id || 'none'} (${summary.selected.reason})`
  );
  console.log(`JSON: ${files.jsonFile}`);
  console.log(`Markdown: ${files.mdFile}`);
  if (!summary.preflight.ok) process.exitCode = 2;
  else if (summary.results.some((result) => result.verdict !== 'PASS')) {
    process.exitCode = 1;
  }
};

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    console.error(`ERROR: ${error.message}`);
    process.exitCode = 1;
  });
}
