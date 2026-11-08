#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);

const value = (name, fallback = '') => process.env[name] || fallback;
const options = {
  port: value('MTPROXY_PORT', '443'),
  container: value('MTPROXY_CONTAINER', ''),
  capture: false,
  captureSeconds: Number(value('MTPROXY_CAPTURE_SECONDS', '20')),
  clientCapture: false,
  clientInterface: value('MTPROXY_CLIENT_IFACE'),
  clientIp: value('MTPROXY_CLIENT_IP'),
  keepPcap: false,
  restartTelegram: false,
  strict: false,
  noReport: false,
  mediaSeconds: Number(value('MTPROXY_MEDIA_SECONDS', '8')),
  reportDir: value('MTPROXY_REPORT_DIR', join(scriptDir, 'data/diagnostics')),
  lenvFile: value('LENV_FILE', join(scriptDir, '.lenv')),
  knownGoodFile: value(
    'MTPROXY_KNOWN_GOOD',
    join(scriptDir, 'scripts/mtproxy/known-good.json')
  ),
  useKnownGood: true,
  compareFile: value('MTPROXY_COMPARE_FILE'),
  apiTest: false,
  apiMedia: false,
  apiRoundtripPhoto: false,
  apiPhotoSize: Number(value('MTPROXY_API_PHOTO_SIZE', '128')),
  apiPhotoColor: value('MTPROXY_API_PHOTO_COLOR'),
  apiPhotoTolerance: Number(value('MTPROXY_API_PHOTO_TOLERANCE', '8')),
  apiPhotoTimeout: Number(value('MTPROXY_API_PHOTO_TIMEOUT_MS', '60000')),
  apiTimeout: Number(value('MTPROXY_API_TIMEOUT_MS', '120000')),
  sshTimeout: Number(value('MTPROXY_SSH_TIMEOUT_MS', '60000')),
  apiRelaxPing: false,
  apiKeep: false,
  apiReceiveLimit: Number(value('MTPROXY_API_RECEIVE_LIMIT', '50')),
  telegramEnvFile: value('TELEGRAM_ENV_FILE'),
  telegramSessionFile: value('TELEGRAM_SESSION_FILE'),
};

const failUsage = (message) => {
  console.error(`ERROR: ${message}`);
  process.exit(2);
};

for (let i = 0; i < args.length; i += 1) {
  const arg = args[i];
  const next = () => {
    const current = args[++i];
    if (current === undefined) failUsage(`missing value for ${arg}`);
    return current;
  };
  if (arg === '-h' || arg === '--help') {
    console.log(`Usage: ./diagnose-mtproxy.mjs [options]

Read-only diagnostics for the self-hosted MTProto proxy and the Telegram client.
The only temporary server change is an optional tcpdump capture.

Options:
  --port <port>              Proxy port (default: 443 or MTPROXY_PORT)
  --container <name>         Proxy container (default: mtproxy-classic-<port>)
  --capture                  Capture server traffic for the configured window
  --capture-seconds <n>      Capture duration (default: 20)
  --client-capture           Capture client traffic too (requires passwordless sudo)
  --client-interface <name>  Client capture interface (default: route to server)
  --client-ip <ip>           Restrict server pcap analysis to one client IP
  --keep-pcap                Keep local and remote pcap files
  --restart-telegram         Restart the macOS Telegram app before capture
  --strict                   Exit non-zero on hard failures
  --no-report                Do not write a timestamped report or summary JSON
  --media-seconds <n>        Sample partial media for n seconds (default: 8)
  --report-dir <path>        Report directory
  --compare <summary.json>   Compare this run with an earlier summary JSON
  --lenv <path>              Path to .lenv (default: ./.lenv)
  --known-good <path>        Known-good profile
  --no-known-good            Skip known-good comparison
  --api-test                 Send and verify a marker through MTProto
  --api-media                Also upload and download a small document through MTProto
  --api-roundtrip-photo      Send, receive, and verify a solid-color photo
  --api-photo-size <n>       Round-trip photo size in pixels (default: 128)
  --api-photo-color <r,g,b>  Fixed round-trip color
  --api-photo-tolerance <n>  Allowed per-channel color delta (default: 8)
  --api-photo-timeout <ms>   Per-photo-step timeout (default: 60000)
  --api-timeout <ms>         Whole API test timeout (default: 120000)
  --ssh-timeout <ms>         Per-SSH-command timeout (default: 60000)
  --api-relax-ping           Raise the diagnostic ping timeout
  --api-keep                 Keep API test messages in Saved Messages
  --api-receive-limit <n>    Messages to scan for a received photo (default: 50)
  --api-receive-profile <p>  Download a profile photo through MTProto (receive-only)
  --api-receive-media <p>    Download the latest photo from a chat (receive-only)
  --telegram-env <path>      Telegram API credentials .env
  --telegram-session <path>  GramJS StringSession file
  -h, --help                 Show this help

Private values are supplied at execution time through .lenv, environment
variables, or the paths above. They are never printed or committed.`);
    process.exit(0);
  } else if (arg === '--port') options.port = next();
  else if (arg === '--container') options.container = next();
  else if (arg === '--capture') options.capture = true;
  else if (arg === '--capture-seconds') options.captureSeconds = Number(next());
  else if (arg === '--client-capture') options.clientCapture = true;
  else if (arg === '--client-interface') options.clientInterface = next();
  else if (arg === '--client-ip') options.clientIp = next();
  else if (arg === '--keep-pcap') options.keepPcap = true;
  else if (arg === '--restart-telegram') options.restartTelegram = true;
  else if (arg === '--strict') options.strict = true;
  else if (arg === '--no-report') options.noReport = true;
  else if (arg === '--media-seconds') options.mediaSeconds = Number(next());
  else if (arg === '--report-dir') options.reportDir = next();
  else if (arg === '--compare') options.compareFile = next();
  else if (arg === '--lenv') options.lenvFile = next();
  else if (arg === '--known-good') {
    options.knownGoodFile = next();
    options.useKnownGood = true;
  } else if (arg === '--no-known-good') options.useKnownGood = false;
  else if (arg === '--api-test') options.apiTest = true;
  else if (arg === '--api-media') {
    options.apiTest = true;
    options.apiMedia = true;
  } else if (arg === '--api-roundtrip-photo') {
    options.apiTest = true;
    options.apiRoundtripPhoto = true;
  } else if (arg === '--api-photo-size') options.apiPhotoSize = Number(next());
  else if (arg === '--api-photo-color') options.apiPhotoColor = next();
  else if (arg === '--api-photo-tolerance')
    options.apiPhotoTolerance = Number(next());
  else if (arg === '--api-photo-timeout')
    options.apiPhotoTimeout = Number(next());
  else if (arg === '--api-timeout') options.apiTimeout = Number(next());
  else if (arg === '--ssh-timeout') options.sshTimeout = Number(next());
  else if (arg === '--api-relax-ping') options.apiRelaxPing = true;
  else if (arg === '--api-keep') options.apiKeep = true;
  else if (arg === '--api-receive-limit')
    options.apiReceiveLimit = Number(next());
  else if (arg === '--api-receive-profile') {
    options.apiTest = true;
    options.apiReceiveProfile = next();
  } else if (arg === '--api-receive-media') {
    options.apiTest = true;
    options.apiReceiveMedia = next();
  } else if (arg === '--telegram-env') options.telegramEnvFile = next();
  else if (arg === '--telegram-session') options.telegramSessionFile = next();
  else failUsage(`unknown option: ${arg}`);
}

options.container ||= `mtproxy-classic-${options.port}`;
if (
  !/^[0-9]+$/.test(options.port) ||
  Number(options.port) < 1 ||
  Number(options.port) > 65535
) {
  failUsage(`invalid --port: ${options.port}`);
}
if (!Number.isInteger(options.captureSeconds) || options.captureSeconds < 5) {
  failUsage(`invalid --capture-seconds: ${options.captureSeconds}`);
}
if (
  !Number.isInteger(options.mediaSeconds) ||
  options.mediaSeconds < 0 ||
  options.mediaSeconds > 120
) {
  failUsage(`invalid --media-seconds: ${options.mediaSeconds}`);
}
if (
  !Number.isInteger(options.apiPhotoSize) ||
  options.apiPhotoSize < 1 ||
  options.apiPhotoSize > 2048
) {
  failUsage(`invalid --api-photo-size: ${options.apiPhotoSize}`);
}
if (
  !Number.isInteger(options.apiPhotoTolerance) ||
  options.apiPhotoTolerance < 0 ||
  options.apiPhotoTolerance > 255
) {
  failUsage(`invalid --api-photo-tolerance: ${options.apiPhotoTolerance}`);
}
if (
  !Number.isFinite(options.apiPhotoTimeout) ||
  options.apiPhotoTimeout < 1000
) {
  failUsage(`invalid --api-photo-timeout: ${options.apiPhotoTimeout}`);
}
if (!Number.isFinite(options.apiTimeout) || options.apiTimeout < 1000) {
  failUsage(`invalid --api-timeout: ${options.apiTimeout}`);
}
if (!Number.isFinite(options.sshTimeout) || options.sshTimeout < 1000) {
  failUsage(`invalid --ssh-timeout: ${options.sshTimeout}`);
}
if (!Number.isInteger(options.apiReceiveLimit) || options.apiReceiveLimit < 1) {
  failUsage(`invalid --api-receive-limit: ${options.apiReceiveLimit}`);
}
if (options.clientCapture && !options.capture) {
  failUsage(
    '--client-capture requires --capture so both sides use the same window'
  );
}
if (!existsSync(options.lenvFile)) failUsage(`cannot read ${options.lenvFile}`);
if (options.apiTest && !options.telegramEnvFile) {
  failUsage('--api-test requires --telegram-env or TELEGRAM_ENV_FILE');
}
if (options.apiTest && !existsSync(options.telegramEnvFile)) {
  failUsage(`cannot read ${options.telegramEnvFile}`);
}
options.telegramSessionFile ||= join(
  dirname(options.telegramEnvFile || options.lenvFile),
  '.telegram_session'
);

const parseKeyValue = (file) => {
  const result = {};
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z0-9_]+)\s*[:=]\s*(.*?)\s*$/);
    if (!match || match[2].startsWith('#')) continue;
    result[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
  }
  return result;
};

const lenv = parseKeyValue(options.lenvFile);
const serverIp = lenv.SERVER_IP || '';
const serverUser = lenv.SERVER_USER || 'root';
const serverPass = lenv.SERVER_PASS || '';
if (!serverIp || !serverPass)
  failUsage('SERVER_IP and SERVER_PASS must be set in the .lenv file');
if (spawnSync('which', ['sshpass']).status !== 0)
  failUsage('sshpass is required (brew install hudochenkov/sshpass/sshpass).');
options.port = String(options.port);

const startedAt = new Date().toISOString();
const runStamp = startedAt
  .replaceAll(/[:.]/g, '-')
  .replace('T', '-')
  .replace('Z', '');
const runId = value('MTPROXY_RUN_ID', runStamp).replaceAll(
  /[^A-Za-z0-9_.-]/g,
  '-'
);
let reportFile = '';
let summaryFile = '';
if (!options.noReport) {
  mkdirSync(options.reportDir, { recursive: true });
  reportFile = join(options.reportDir, `mtproxy-${runStamp}.log`);
  summaryFile = join(options.reportDir, `mtproxy-${runStamp}.json`);
  appendFileSync(reportFile, '');
}

const note = (line = '') => {
  const stamped = line === '' ? '' : `[${new Date().toISOString()}] ${line}`;
  process.stdout.write(`${stamped}\n`);
  if (reportFile) appendFileSync(reportFile, `${stamped}\n`);
};
const section = (title) => {
  note('');
  note(`== ${title} ==`);
};
const sh = (text) => `'${String(text).replaceAll("'", `'\\''`)}'`;
const command = (
  cmd,
  cmdArgs,
  {
    input,
    env,
    maxBuffer = 64 * 1024 * 1024,
    encoding = 'utf8',
    timeout = 0,
  } = {}
) =>
  spawnSync(cmd, cmdArgs, {
    encoding,
    input,
    env: { ...process.env, ...env },
    maxBuffer,
    timeout,
  });
const sshOptions = [
  '-o',
  'StrictHostKeyChecking=no',
  '-o',
  'UserKnownHostsFile=/dev/null',
  '-o',
  'ConnectTimeout=15',
  '-o',
  'LogLevel=ERROR',
  '-o',
  'PubkeyAuthentication=no',
  '-o',
  'PreferredAuthentications=password',
];
const remote = (
  remoteCommand,
  { input, encoding = 'utf8', timeout = options.sshTimeout } = {}
) =>
  command(
    'sshpass',
    ['-e', 'ssh', ...sshOptions, `${serverUser}@${serverIp}`, remoteCommand],
    {
      input,
      env: { SSHPASS: serverPass },
      maxBuffer: 256 * 1024 * 1024,
      encoding,
      timeout,
    }
  );

const publicIp = (() => {
  const result = command('curl', [
    '-4',
    '-fsS',
    '--max-time',
    '5',
    'https://api.ipify.org',
  ]);
  return result.status === 0 ? result.stdout.trim() : '';
})();
const routeResult = command('route', ['-n', 'get', serverIp]);
const routeInterface =
  routeResult.stdout.match(/interface:\s*(\S+)/)?.[1] || '';
const routeGateway = routeResult.stdout.match(/gateway:\s*(\S+)/)?.[1] || '';
const clientInterface = options.clientInterface || routeInterface || 'en0';

const group = join(
  homedir(),
  'Library/Group Containers/6N38VWS5BX.ru.keepcoder.Telegram/appstore'
);
const appConfigFile = join(group, 'accounts-shared-data');
const appLogsDir = join(group, 'logs');

const app = {
  status: 'unknown',
  host: '',
  port: '',
  prefix: '',
  secretSha: '',
  logPath: '',
  logBaseline: 0,
  noResponse: 0,
  noResponseTotal: 0,
  resumes: 0,
};

if (!existsSync(appConfigFile)) {
  app.status = 'missing-config';
} else {
  const result = command(process.execPath, [
    join(scriptDir, 'scripts/mtproxy/app-config.mjs'),
    appConfigFile,
  ]);
  const lines = Object.fromEntries(
    result.stdout
      .split(/\r?\n/)
      .map((line) => line.split('='))
      .filter(([key]) => key)
  );
  app.status = lines.status || 'unknown';
  app.host = lines.host || '';
  app.port = lines.port || '';
  app.prefix = lines.prefix || '';
  app.secretSha = lines.sha || '';
  if (app.status === 'ok' && app.host === serverIp && app.port === options.port)
    app.status = 'match';
  else if (app.status === 'ok') app.status = 'mismatch';
}

const appLogFile = (() => {
  if (!existsSync(appLogsDir)) return '';
  const files = readdirSync(appLogsDir)
    .filter((name) => /^critlog-.*\.txt$/.test(name))
    .map((name) => join(appLogsDir, name))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  return files[0] || '';
})();
if (appLogFile) {
  app.logPath = appLogFile;
  app.logBaseline = statSync(appLogFile).size;
  const text = readFileSync(appLogFile, 'latin1');
  app.noResponseTotal = (
    text.match(/no response|invalidating the transport|connection.*stuck/gi) ||
    []
  ).length;
  const tail = text.slice(-400000);
  app.resumes = (
    tail.match(/resume|reconnect|transport.*restart/gi) || []
  ).length;
}

const appLogDelta = () => {
  if (!app.logPath) return 0;
  const buffer = readFileSync(app.logPath);
  return (
    buffer
      .subarray(app.logBaseline)
      .toString('latin1')
      .match(/no response|invalidating the transport|connection.*stuck/gi) || []
  ).length;
};

const appLogLines = () => {
  if (!app.logPath) return [];
  const buffer = readFileSync(app.logPath);
  return buffer
    .subarray(app.logBaseline)
    .toString('latin1')
    .split(/\r?\n/)
    .filter((line) =>
      /no response|invalidating the transport|connection.*stuck|resume|reconnect/i.test(
        line
      )
    )
    .slice(-40)
    .map((line) => line.replace(/\b[0-9a-f]{32}\b/gi, '[redacted-secret]'));
};

const media = { dir: '', partial: 0, bytes: 0, recent: 0, growth: 0 };
const findMediaDir = () => {
  if (!existsSync(group)) return '';
  for (const name of readdirSync(group)) {
    const candidate = join(group, name, 'media');
    if (existsSync(candidate)) return candidate;
  }
  return '';
};
const snapshotMedia = (dir) => {
  let partial = 0;
  let bytes = 0;
  let recent = 0;
  const walk = (current, depth) => {
    if (depth > 3) return;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(path, depth + 1);
        continue;
      }
      const stat = statSync(path);
      if (/_partial|\.partial$/i.test(entry.name)) {
        partial += 1;
        bytes += stat.size;
      } else if (
        stat.size > 100 * 1024 &&
        Date.now() - stat.mtimeMs < 30 * 60 * 1000
      ) {
        recent += 1;
      }
    }
  };
  walk(dir, 0);
  return { partial, bytes, recent };
};
media.dir = findMediaDir();
if (media.dir) Object.assign(media, snapshotMedia(media.dir));
if (media.dir && options.mediaSeconds > 0) {
  const before = media.bytes;
  await new Promise((resolveDelay) =>
    setTimeout(resolveDelay, options.mediaSeconds * 1000)
  );
  media.growth = snapshotMedia(media.dir).bytes - before;
}

const local = {
  estab: 0,
  sendqMax: 0,
  recvqMax: 0,
  sendq: false,
  tcpReachable: null,
  direct: [],
  pmtu: [],
};

section('Local path');
note(`public ip: ${publicIp || 'unavailable'}`);
note(`server: ${serverIp}`);
note(`proxy:  ${serverIp}:${options.port}`);
note(
  `interface: ${clientInterface || 'unknown'} gateway=${routeGateway || 'unknown'}`
);
note(`report: ${reportFile || 'disabled'}`);
note(`summary: ${summaryFile || 'disabled'}`);
note(`run id: ${runId} started=${startedAt}`);

section('Local Telegram client');
note(`app proxy status: ${app.status}`);
note(`app proxy host:   ${app.host || 'unknown'}`);
note(`app proxy port:   ${app.port || 'unknown'}`);
note(`app secret prefix: ${app.prefix || 'unknown'}`);
if (app.secretSha) note(`app secret sha256: ${app.secretSha}`);
if (app.logPath) {
  note(`app log: ${app.logPath}`);
  note(`app no-response lines (historical): ${app.noResponseTotal}`);
  note(`app resume/reconnect lines (last 400): ${app.resumes}`);
}

section('Local media');
if (media.dir) {
  note(`media dir: ${media.dir}`);
  note(`partial files: ${media.partial} (${media.bytes} bytes)`);
  note(`recent completed files (30m): ${media.recent}`);
  note(`partial growth over ${options.mediaSeconds}s: ${media.growth} bytes`);
} else {
  note('media dir not found');
}

section('Local sockets to proxy');
const socketResult = command('netstat', ['-anv', '-p', 'tcp']);
const socketLines = socketResult.stdout
  .split(/\r?\n/)
  .filter(
    (line) =>
      new RegExp(`[.]${options.port}\\s`).test(line) && line.includes(serverIp)
  );
if (!socketLines.length) {
  note(`no local TCP sockets to ${serverIp}:${options.port}`);
} else {
  for (const line of socketLines.slice(0, 40)) note(line);
  for (const line of socketLines) {
    const fields = line.trim().split(/\s+/);
    if (fields[5] !== 'ESTABLISHED') continue;
    local.estab += 1;
    local.sendqMax = Math.max(local.sendqMax, Number(fields[2]) || 0);
    local.recvqMax = Math.max(local.recvqMax, Number(fields[1]) || 0);
  }
  note(
    `established sockets: ${local.estab}; max Send-Q: ${local.sendqMax}; max Recv-Q: ${local.recvqMax}`
  );
  if (local.sendqMax > 0) {
    local.sendq = true;
    note(
      'INFO: local Send-Q is non-zero (normal during transfer; compare with remote payload).'
    );
  }
}

section('Local TCP counters');
const tcpStats = command('netstat', ['-s', '-p', 'tcp'])
  .stdout.split(/\r?\n/)
  .map((line) => line.trim())
  .filter((line) => /retrans|drop|timeout|duplicate|bad|reset/i.test(line))
  .slice(0, 24);
if (tcpStats.length === 0) note('no matching local TCP counter lines');
for (const line of tcpStats) note(`CLIENT ${line}`);

section('Proxy TCP reachability');
const ncResult = command('nc', ['-vz', '-G', '5', serverIp, options.port]);
local.tcpReachable = ncResult.status === 0;
note(
  `${local.tcpReachable ? 'PASS' : 'FAIL'}: TCP ${serverIp}:${options.port} ${local.tcpReachable ? 'is' : 'is not'} reachable`
);

section('Direct Telegram DC reachability');
for (const dc of [
  '149.154.167.41:443',
  '91.108.56.130:443',
  '149.154.175.50:443',
]) {
  const [host, port] = dc.split(':');
  const reachable = command('nc', ['-vz', '-G', '5', host, port]).status === 0;
  local.direct.push({ dc, reachable });
  note(`${reachable ? 'PASS' : 'FAIL'}: direct ${dc}`);
}

section('Path MTU to proxy');
let maxOk = 0;
for (const size of [
  1472, 1464, 1450, 1440, 1420, 1400, 1380, 1300, 1200, 1100,
]) {
  const ok =
    command('ping', [
      '-D',
      '-s',
      String(size),
      '-c',
      '2',
      '-W',
      '1000',
      serverIp,
    ]).status === 0;
  local.pmtu.push({ size, ok });
  if (ok) maxOk = Math.max(maxOk, size);
  note(`${ok ? 'PASS' : 'FAIL'}: payload ${size} (MTU ${size + 28})`);
}
if (maxOk) {
  note(`max working IPv4 payload: ${maxOk} (MTU ${maxOk + 28})`);
  if (maxOk < 1472)
    note(
      'WARN: path MTU is below 1500; large ClientHello segments may be dropped.'
    );
} else {
  note('FAIL: no tested payload size succeeded');
}

const remoteScript = `set -u
echo "host: $(hostname)"
echo "date: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "run_id: ${'$'}{RUN_ID:-unknown}"
if [ -r /etc/os-release ]; then . /etc/os-release; echo "os: ${'$'}{PRETTY_NAME:-unknown}"; fi
if ! docker inspect "$CONTAINER" >/dev/null 2>&1; then
  for candidate in "mtproxy-classic-$PORT" "mtproxy"; do
    if docker inspect "$candidate" >/dev/null 2>&1; then CONTAINER="$candidate"; break; fi
  done
fi
if ! docker inspect "$CONTAINER" >/dev/null 2>&1; then
  echo "container: MISSING ($CONTAINER)"
  echo "container_effective=$CONTAINER"
  exit 0
fi
echo "container: $(docker ps -a --filter "name=^${'$'}{CONTAINER}$" --format '{{.Status}} ports={{.Ports}}')"
echo "container_effective=$CONTAINER"
IMAGE="$(docker inspect -f '{{.Config.Image}}' "$CONTAINER")"
echo "image: $IMAGE"
echo "restarts: $(docker inspect -f '{{.RestartCount}}' "$CONTAINER")"
echo "restart_policy=$(docker inspect -f '{{.HostConfig.RestartPolicy.Name}}' "$CONTAINER")"
echo "network_mode=$(docker inspect -f '{{.HostConfig.NetworkMode}}' "$CONTAINER")"
echo "container_running=$(docker inspect -f '{{.State.Running}}' "$CONTAINER")"
echo "image_id=$(docker inspect -f '{{.Image}}' "$CONTAINER")"
echo "workers_env=$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$CONTAINER" 2>/dev/null | grep -E '^WORKERS=' | head -1 || true)"
echo "nofile_limit=$(docker inspect -f '{{range .HostConfig.Ulimits}}{{println .Name}}={{.Soft}}:{{.Hard}}{{end}}' "$CONTAINER" 2>/dev/null | grep '^nofile=' | head -1 || true)"
echo "host_nofile=$(ulimit -n 2>/dev/null || true)"
PID="$(docker inspect -f '{{.State.Pid}}' "$CONTAINER" 2>/dev/null || true)"
echo "pid=${'$'}{PID:-unknown}"
if [ -n "${'$'}{PID:-}" ] && [ "$PID" != "0" ]; then
  echo "container_nofile=$(docker exec "$CONTAINER" sh -c 'ulimit -n' 2>/dev/null || true)"
else
  echo "container_nofile=unknown"
fi
echo "tcp_congestion_control=$(sysctl -n net.ipv4.tcp_congestion_control 2>/dev/null || true)"
echo "tcp_rmem=$(sysctl -n net.ipv4.tcp_rmem 2>/dev/null || true)"
echo "tcp_wmem=$(sysctl -n net.ipv4.tcp_wmem 2>/dev/null || true)"
echo "somaxconn=$(sysctl -n net.core.somaxconn 2>/dev/null || true)"
SECRET_FILE="$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Source}}{{end}}{{end}}' "$CONTAINER" 2>/dev/null || true)"
PROXY_SECRET_SHA=""
if [ -n "$SECRET_FILE" ] && [ -r "$SECRET_FILE/secret" ]; then
  PROXY_SECRET_SHA="$(tr -d ' \\r\\n' < "$SECRET_FILE/secret" | sha256sum | cut -d' ' -f1)"
elif [ -n "$PID" ] && [ "$PID" != "0" ]; then
  PROXY_SECRET_SHA="$(docker exec "$CONTAINER" sh -c 'cat /data/secret 2>/dev/null' 2>/dev/null | tr -d ' \\r\\n' | sha256sum | cut -d' ' -f1)"
fi
echo "proxy_secret_sha256=${'$'}{PROXY_SECRET_SHA:-unknown}"
echo "port_listening=$(ss -ltnH 2>/dev/null | grep -cE "[:.]$PORT[[:space:]]" || true)"
echo "mss_rule_count=$(( $(iptables -t mangle -S 2>/dev/null | grep -ci mss || true) + $(iptables -S 2>/dev/null | grep -ci mss || true) ))"
echo "mss_service=$(systemctl is-enabled mtproxy-mss.service 2>/dev/null || true),$(systemctl is-active mtproxy-mss.service 2>/dev/null || true)"
CONF_FILE="$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Source}}{{end}}{{end}}' "$CONTAINER" 2>/dev/null || true)/proxy.conf"
if [ -r "$CONF_FILE" ]; then
  echo "proxy_conf_sha256=$(sha256sum "$CONF_FILE" 2>/dev/null | cut -d' ' -f1 || true)"
  echo "proxy_dc2_main=$(grep -c '^proxy_for 2 149\\.154\\.161\\.144:8888;' "$CONF_FILE" 2>/dev/null || true)"
  echo "proxy_dc2_media=$(grep -c '^proxy_for -2 149\\.154\\.161\\.184:8888;' "$CONF_FILE" 2>/dev/null || true)"
  echo "proxy_media203=$(grep -c '^proxy_for -203 91\\.105\\.192\\.110:443;' "$CONF_FILE" 2>/dev/null || true)"
else
  echo "proxy_conf_sha256=unknown"; echo "proxy_dc2_main=0"; echo "proxy_dc2_media=0"; echo "proxy_media203=0"
fi
case "$IMAGE" in *mtg*) PROXY_TYPE="mtg" ;; *) PROXY_TYPE="mtproto-proxy/classic" ;; esac
echo; echo "-- proxy type --"; echo "$PROXY_TYPE"
echo; echo "-- classic proxy.conf --"
if [ "$PROXY_TYPE" = "mtproto-proxy/classic" ] && [ -r "$CONF_FILE" ]; then
  sed -E 's/(secret[[:space:]]*[=:][[:space:]]*)[^[:space:]]+/\\1REDACTED/Ig' "$CONF_FILE"
else
  echo "not applicable or unreadable"
fi
echo; echo "-- recent logs (remote timestamps) --"
docker logs -t --since 15m "$CONTAINER" 2>&1 | tail -120 | sed -E 's/(secret[[:space:]]*[=:][[:space:]]*)[^[:space:]]+/\\1REDACTED/Ig' || true
echo; echo "-- container sockets --"
if [ -n "${'$'}{PID:-}" ] && [ "$PID" != "0" ]; then
  nsenter -t "$PID" -n ss -tnp 2>/dev/null | head -200 || true
else echo "no container pid"; fi
echo; echo "-- socket summary --"
if [ -n "${'$'}{PID:-}" ] && [ "$PID" != "0" ]; then
  nsenter -t "$PID" -n ss -tn 2>/dev/null | awk -v port="$PORT" '
    $1 == "ESTAB" {
      local = $4; peer = $5; sendq = $3 + 0
      if (local ~ ":" port "$") { client++; if (sendq > maxsendq) maxsendq = sendq; if (sendq > 100000) stalled++ }
      if (peer ~ /149[.]154[.]|91[.]108[.]|2001:67c:4e8/) dc++
      if (peer ~ /:443$/ && peer !~ /149[.]154[.]|91[.]108[.]|2001:67c:4e8/) other443++
    }
    END { printf "client_connections=%d telegram_dc_connections=%d other_443=%d server_sendq_max=%d stalled_client_connections=%d\\n", client, dc, other443, maxsendq, stalled }'
fi
echo; echo "-- dc2 main upstream (text path) --"
if [ -n "${'$'}{PID:-}" ] && [ "$PID" != "0" ]; then
  nsenter -t "$PID" -n ss -tinH state established "( dport = :8888 )" 2>/dev/null > /tmp/mtproxy-ss-dc.txt || true
  DC2_CONNS="$(grep -c '149\\.154\\.161\\.144:8888' /tmp/mtproxy-ss-dc.txt 2>/dev/null || true)"
  DC2_ACTIVE="$(grep -A1 '149\\.154\\.161\\.144:8888' /tmp/mtproxy-ss-dc.txt 2>/dev/null | grep -o 'bytes_sent:[0-9]*' | awk -F: '$2+0 > 92 {c++} END {print c+0}')"
  echo "dc2_main_connections=${'$'}{DC2_CONNS:-0} dc2_main_active=${'$'}{DC2_ACTIVE:-0}"
fi
echo; echo "-- host sockets on port --"; ss -tn 2>/dev/null | grep -E "[:.]$PORT[[:space:]]" || true
echo; echo "-- host TCP counters --"
nstat -az 2>/dev/null | grep -E 'TcpRetransSegs|TcpExtTCPLostRetransmit|TcpExtTCPTimeouts|TcpExtTCPSynRetrans|TcpOutSegs|TcpInSegs' || true
echo; echo "-- container TCP counters --"
if [ -n "${'$'}{PID:-}" ] && [ "$PID" != "0" ]; then
  nsenter -t "$PID" -n nstat -az 2>/dev/null | grep -E 'TcpRetransSegs|TcpExtTCPLostRetransmit|TcpExtTCPTimeouts|TcpExtTCPSynRetrans|TcpOutSegs|TcpInSegs' || true
else echo "no container pid"; fi
echo; echo "-- TCPMSS rules --"; iptables -t mangle -S 2>/dev/null | grep -i mss || true; iptables -S 2>/dev/null | grep -i mss || true; nft list ruleset 2>/dev/null | grep -i mss || true
echo; echo "-- mtg doctor --"
if [ "$PROXY_TYPE" = "mtg" ]; then docker exec "$CONTAINER" /mtg doctor /config.toml 2>&1 | tail -100 || true; else echo "not applicable (classic mtproto-proxy)"; fi`;

const remoteResult = remote(
  `PORT=${sh(options.port)} CONTAINER=${sh(options.container)} RUN_ID=${sh(runId)} bash -s`,
  {
    input: remoteScript,
  }
);
const remoteOutput = remoteResult.stdout || '';
const remoteError = remoteResult.stderr || '';
const remoteAvailable = remoteOutput.trim().length > 0;
section('Remote proxy');
note(remoteOutput);
if (remoteError.trim()) note(remoteError.trim());

const metric = (key) => {
  const match = remoteOutput.match(new RegExp(`(?:^|\\s)${key}=(\\d+)`, 'm'));
  return match ? Number(match[1]) : 0;
};
const metricText = (key) => {
  const match = remoteOutput.match(new RegExp(`(?:^|\\s)${key}=(.*)$`, 'm'));
  return match ? match[1] : '';
};
const remoteState = {
  container: metricText('container_effective') || options.container,
  image: metricText('image'),
  imageId: metricText('image_id'),
  running: metricText('container_running'),
  workers: metricText('workers_env'),
  nofile: metricText('nofile_limit'),
  hostNofile: metricText('host_nofile'),
  containerNofile: metricText('container_nofile'),
  tcpCongestion: metricText('tcp_congestion_control'),
  network: metricText('network_mode'),
  restart: metricText('restart_policy'),
  mssService: metricText('mss_service'),
  proxyConfSha: metricText('proxy_conf_sha256'),
  secretSha: metricText('proxy_secret_sha256'),
  listening: metric('port_listening'),
  mssRules: metric('mss_rule_count'),
  proxyDc2Main: metric('proxy_dc2_main'),
  proxyDc2Media: metric('proxy_dc2_media'),
  proxyMedia203: metric('proxy_media203'),
  client: metric('client_connections'),
  dc: metric('telegram_dc_connections'),
  other443: metric('other_443'),
  sendqMax: metric('server_sendq_max'),
  stalled: metric('stalled_client_connections'),
  noPayload: metric('client_no_payload'),
  active: metric('client_active'),
  bytesReceived: metric('client_bytes_received'),
  bytesSent: metric('client_bytes_sent'),
  dc2Main: metric('dc2_main_connections'),
  dc2MainActive: metric('dc2_main_active'),
  pid: metricText('pid'),
  type: remoteOutput.includes('mtproto-proxy/classic')
    ? 'classic'
    : remoteOutput.includes('mtg')
      ? 'mtg'
      : '',
};
if (!remoteAvailable)
  note('FAIL: remote diagnostics unavailable; server checks were skipped.');

if (
  remoteState.pid &&
  remoteState.pid !== 'unknown' &&
  remoteState.pid !== '0'
) {
  const ss = remote(
    `nsenter -t ${sh(remoteState.pid)} -n ss -tinH state established 2>/dev/null`
  );
  if (ss.stdout.trim()) {
    const summary = command(
      process.execPath,
      [join(scriptDir, 'scripts/mtproxy/ss-tin.mjs'), '--port', options.port],
      {
        input: ss.stdout,
      }
    );
    if (summary.stdout.trim()) {
      note('\n-- socket payload summary --');
      note(summary.stdout.trim());
      for (const line of summary.stdout.trim().split(/\s+/)) {
        const [key, metricValue] = line.split('=');
        if (!key) continue;
        if (key === 'client_no_payload')
          remoteState.noPayload = Number(metricValue) || 0;
        if (key === 'client_active')
          remoteState.active = Number(metricValue) || 0;
        if (key === 'client_bytes_received')
          remoteState.bytesReceived = Number(metricValue) || 0;
        if (key === 'client_bytes_sent')
          remoteState.bytesSent = Number(metricValue) || 0;
      }
    }
  }
}

const capture = {
  ok: false,
  path: '',
  clientBytes: 0,
  proxyBytes: 0,
  clientConns: 0,
  proxyConns: 0,
  clientRetransmits: 0,
  clientRetransmitBytes: 0,
  proxyRetransmits: 0,
  proxyRetransmitBytes: 0,
  clientDuplicateAcks: 0,
  proxyDuplicateAcks: 0,
  clientRst: 0,
  proxyRst: 0,
  proxyAckGapMax: 0,
  proxyAckGapSum: 0,
  proxyAckGapFlows: 0,
  clientAckGapMax: 0,
  clientAckGapSum: 0,
  mss: '',
  startedAt: '',
  finishedAt: '',
};
const pcapField = (output, key) => {
  const match = output.match(new RegExp(`^${key}=(.*)$`, 'm'));
  return match ? match[1] : '';
};
const applyPcapFields = (target, output) => {
  target.clientBytes = Number(pcapField(output, 'CAPTURE_CLIENT_BYTES')) || 0;
  target.proxyBytes = Number(pcapField(output, 'CAPTURE_PROXY_BYTES')) || 0;
  target.clientConns = Number(pcapField(output, 'CAPTURE_CLIENT_CONNS')) || 0;
  target.proxyConns = Number(pcapField(output, 'CAPTURE_PROXY_CONNS')) || 0;
  target.clientRetransmits =
    Number(pcapField(output, 'CAPTURE_CLIENT_RETRANSMITS')) || 0;
  target.clientRetransmitBytes =
    Number(pcapField(output, 'CAPTURE_CLIENT_RETRANSMIT_BYTES')) || 0;
  target.proxyRetransmits =
    Number(pcapField(output, 'CAPTURE_PROXY_RETRANSMITS')) || 0;
  target.proxyRetransmitBytes =
    Number(pcapField(output, 'CAPTURE_PROXY_RETRANSMIT_BYTES')) || 0;
  target.clientDuplicateAcks =
    Number(pcapField(output, 'CAPTURE_CLIENT_DUP_ACKS')) || 0;
  target.proxyDuplicateAcks =
    Number(pcapField(output, 'CAPTURE_PROXY_DUP_ACKS')) || 0;
  target.clientRst = Number(pcapField(output, 'CAPTURE_CLIENT_RST')) || 0;
  target.proxyRst = Number(pcapField(output, 'CAPTURE_PROXY_RST')) || 0;
  target.proxyAckGapMax =
    Number(pcapField(output, 'CAPTURE_PROXY_ACK_GAP_MAX')) || 0;
  target.proxyAckGapSum =
    Number(pcapField(output, 'CAPTURE_PROXY_ACK_GAP_SUM')) || 0;
  target.proxyAckGapFlows =
    Number(pcapField(output, 'CAPTURE_PROXY_ACK_GAP_FLOWS')) || 0;
  target.clientAckGapMax =
    Number(pcapField(output, 'CAPTURE_CLIENT_ACK_GAP_MAX')) || 0;
  target.clientAckGapSum =
    Number(pcapField(output, 'CAPTURE_CLIENT_ACK_GAP_SUM')) || 0;
  target.mss = pcapField(output, 'CAPTURE_MSS');
};
const analyzeCapture = (path) => {
  const raw = remote(`cat ${sh(path)}`, { encoding: null, timeout: 120000 });
  const result = command(
    process.execPath,
    [
      join(scriptDir, 'scripts/mtproxy/pcap.mjs'),
      '--port',
      options.port,
      '--client',
      options.clientIp || publicIp,
    ],
    {
      input: raw.stdout,
      maxBuffer: 512 * 1024 * 1024,
    }
  );
  note(result.stdout.trim());
  applyPcapFields(capture, result.stdout);
  capture.ok = result.stdout.includes('CAPTURE_CLIENT_BYTES=');
  capture.finishedAt = new Date().toISOString();
};
let apiResult = { status: 'skipped', output: '', error: '' };
const runApiTest = () => {
  const result = { status: 'skipped', output: '', error: '' };
  section('Telegram API test');
  const secretResult = remote(
    `docker exec ${sh(remoteState.container)} sh -c 'cat /data/secret 2>/dev/null'`
  );
  const secretKey = secretResult.stdout.trim();
  if (!/^[0-9a-f]{32}$/i.test(secretKey)) {
    result.status = 'FAIL';
    note('FAIL: could not read the proxy secret for the API test.');
    return result;
  }
  const api = command(
    process.execPath,
    [
      join(scriptDir, 'scripts/mtproxy/api-test.mjs'),
      '--host',
      serverIp,
      '--port',
      options.port,
      '--env-file',
      options.telegramEnvFile,
      '--session-file',
      options.telegramSessionFile,
      '--lenv',
      options.lenvFile,
      ...(options.apiMedia ? ['--media'] : []),
      ...(options.apiRoundtripPhoto ? ['--roundtrip-photo'] : []),
      ...(options.apiRoundtripPhoto
        ? ['--photo-size', String(options.apiPhotoSize)]
        : []),
      ...(options.apiPhotoColor
        ? ['--photo-color', options.apiPhotoColor]
        : []),
      ...(options.apiRoundtripPhoto
        ? ['--photo-tolerance', String(options.apiPhotoTolerance)]
        : []),
      ...(options.apiRoundtripPhoto
        ? ['--photo-timeout', String(options.apiPhotoTimeout)]
        : []),
      ...(options.apiRelaxPing ? ['--relax-ping'] : []),
      ...(options.apiKeep ? ['--keep'] : []),
      ...(options.apiReceiveProfile
        ? ['--receive-profile', options.apiReceiveProfile]
        : []),
      ...(options.apiReceiveMedia
        ? [
            '--receive-media',
            '--chat',
            options.apiReceiveMedia,
            '--receive-limit',
            String(options.apiReceiveLimit),
          ]
        : []),
    ],
    { env: { MTPROXY_SECRET_KEY: secretKey } }
  );
  result.output = `${api.stdout}${api.stderr}`.trim();
  note(result.output);
  const status = result.output.match(/^API_TEST_STATUS=(.*)$/m);
  const error = result.output.match(/^API_TEST_ERROR=(.*)$/m);
  result.status = status ? status[1] : 'FAIL';
  result.error = error ? error[1] : '';
  return result;
};

const awaitDelay = (ms) =>
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

const clientCapture = {
  ok: false,
  path: '',
  interface: '',
  sentBytes: 0,
  recvBytes: 0,
  sentRetransmits: 0,
  sentRetransmitBytes: 0,
  recvRetransmits: 0,
  recvRetransmitBytes: 0,
  sentDuplicateAcks: 0,
  recvDuplicateAcks: 0,
  sentRst: 0,
  recvRst: 0,
  recvAckGapMax: 0,
  recvAckGapSum: 0,
  recvAckGapFlows: 0,
  sentAckGapMax: 0,
  sentAckGapSum: 0,
  mss: '',
  startedAt: '',
  finishedAt: '',
  error: '',
};
let clientCaptureProcess = null;
let clientCaptureStderr = '';

const startClientCapture = () => {
  section('Client packet capture');
  clientCapture.interface = clientInterface;
  clientCapture.path = join(tmpdir(), `mtproxy-client-${runId}.pcap`);
  if (existsSync(clientCapture.path)) {
    try {
      unlinkSync(clientCapture.path);
    } catch {
      note(`WARN: could not remove old client capture ${clientCapture.path}`);
    }
  }
  const filter = `tcp port ${options.port} and host ${serverIp}`;
  const sudoCheck = command('sudo', ['-n', 'true']);
  if (sudoCheck.status !== 0) {
    clientCapture.error =
      `${sudoCheck.stderr || 'passwordless sudo is unavailable'}`.trim();
    note(`FAIL: client capture did not start: ${clientCapture.error}`);
    note(
      `Run manually: sudo tcpdump -i ${clientCapture.interface} -nn -s0 -U -w /tmp/client.pcap '${filter}'`
    );
    return;
  }
  note(`Starting client tcpdump on ${clientCapture.interface}: ${filter}`);
  clientCaptureProcess = spawn(
    'sudo',
    [
      '-n',
      'tcpdump',
      '-i',
      clientCapture.interface,
      '-nn',
      '-s0',
      '-U',
      '-w',
      clientCapture.path,
      filter,
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] }
  );
  clientCaptureProcess.stderr.on('data', (chunk) => {
    clientCaptureStderr += chunk.toString();
  });
  clientCaptureProcess.on('error', (error) => {
    clientCapture.error = error.message;
  });
  awaitDelay(1200);
  if (
    clientCaptureProcess.exitCode !== null ||
    clientCapture.error ||
    !existsSync(clientCapture.path) ||
    statSync(clientCapture.path).size < 24
  ) {
    clientCapture.error ||= clientCaptureStderr.trim() || 'sudo tcpdump exited';
    note(`FAIL: client capture did not start: ${clientCapture.error}`);
    note(
      `Run manually: sudo tcpdump -i ${clientCapture.interface} -nn -s0 -U -w /tmp/client.pcap '${filter}'`
    );
    clientCaptureProcess = null;
    return;
  }
  clientCapture.startedAt = new Date().toISOString();
  note(`CLIENT_CAPTURE_STARTED=yes path=${clientCapture.path}`);
};

const stopClientCapture = () => {
  if (!clientCaptureProcess) return;
  if (clientCaptureProcess.exitCode === null)
    clientCaptureProcess.kill('SIGINT');
  awaitDelay(1000);
  if (clientCaptureProcess.exitCode === null)
    clientCaptureProcess.kill('SIGKILL');
  awaitDelay(300);
  clientCaptureProcess = null;
  clientCapture.finishedAt = new Date().toISOString();
  note(`CLIENT_CAPTURE_STOPPED=yes path=${clientCapture.path}`);
};

const analyzeClientCapture = () => {
  if (!clientCapture.startedAt || !existsSync(clientCapture.path)) {
    note('CLIENT_CAPTURE=unavailable');
    return;
  }
  const raw = readFileSync(clientCapture.path);
  if (raw.length < 24) {
    note('CLIENT_CAPTURE=empty');
    if (!options.keepPcap) {
      try {
        unlinkSync(clientCapture.path);
      } catch {}
    }
    return;
  }
  const result = command(
    process.execPath,
    [join(scriptDir, 'scripts/mtproxy/pcap.mjs'), '--port', options.port],
    {
      input: raw,
      maxBuffer: 512 * 1024 * 1024,
    }
  );
  note('-- client capture analysis --');
  note(result.stdout.trim());
  clientCapture.sentBytes =
    Number(pcapField(result.stdout, 'CAPTURE_CLIENT_BYTES')) || 0;
  clientCapture.recvBytes =
    Number(pcapField(result.stdout, 'CAPTURE_PROXY_BYTES')) || 0;
  clientCapture.sentRetransmits =
    Number(pcapField(result.stdout, 'CAPTURE_CLIENT_RETRANSMITS')) || 0;
  clientCapture.sentRetransmitBytes =
    Number(pcapField(result.stdout, 'CAPTURE_CLIENT_RETRANSMIT_BYTES')) || 0;
  clientCapture.recvRetransmits =
    Number(pcapField(result.stdout, 'CAPTURE_PROXY_RETRANSMITS')) || 0;
  clientCapture.recvRetransmitBytes =
    Number(pcapField(result.stdout, 'CAPTURE_PROXY_RETRANSMIT_BYTES')) || 0;
  clientCapture.sentDuplicateAcks =
    Number(pcapField(result.stdout, 'CAPTURE_CLIENT_DUP_ACKS')) || 0;
  clientCapture.recvDuplicateAcks =
    Number(pcapField(result.stdout, 'CAPTURE_PROXY_DUP_ACKS')) || 0;
  clientCapture.sentRst =
    Number(pcapField(result.stdout, 'CAPTURE_CLIENT_RST')) || 0;
  clientCapture.recvRst =
    Number(pcapField(result.stdout, 'CAPTURE_PROXY_RST')) || 0;
  clientCapture.recvAckGapMax =
    Number(pcapField(result.stdout, 'CAPTURE_PROXY_ACK_GAP_MAX')) || 0;
  clientCapture.recvAckGapSum =
    Number(pcapField(result.stdout, 'CAPTURE_PROXY_ACK_GAP_SUM')) || 0;
  clientCapture.recvAckGapFlows =
    Number(pcapField(result.stdout, 'CAPTURE_PROXY_ACK_GAP_FLOWS')) || 0;
  clientCapture.sentAckGapMax =
    Number(pcapField(result.stdout, 'CAPTURE_CLIENT_ACK_GAP_MAX')) || 0;
  clientCapture.sentAckGapSum =
    Number(pcapField(result.stdout, 'CAPTURE_CLIENT_ACK_GAP_SUM')) || 0;
  clientCapture.mss = pcapField(result.stdout, 'CAPTURE_MSS');
  clientCapture.ok = result.stdout.includes('CAPTURE_CLIENT_BYTES=');
  if (!options.keepPcap) {
    try {
      unlinkSync(clientCapture.path);
    } catch {}
  }
};

const startCapture = () => {
  section('Packet capture');
  note(`Starting a ${options.captureSeconds}s tcpdump on the server.`);
  const result = remote(
    `PORT=${sh(options.port)} SECONDS=${sh(String(options.captureSeconds))} bash -s`,
    {
      input: `set -u
CAP="/tmp/mtproxy-diagnose-$(date +%s).pcap"
rm -f /tmp/mtproxy-diagnose-last.path
nohup timeout "$SECONDS" tcpdump -i any -nn -s0 -U -w "$CAP" "tcp port $PORT" >/tmp/mtproxy-diagnose-tcpdump.log 2>&1 &
printf '%s\\n' "$CAP" > /tmp/mtproxy-diagnose-last.path
echo "$CAP"
sleep 1
if kill -0 $! 2>/dev/null; then echo "CAPTURE_STARTED"; else echo "CAPTURE_FAILED"; cat /tmp/mtproxy-diagnose-tcpdump.log; fi`,
    }
  );
  note(result.stdout.trim());
  if (!result.stdout.includes('CAPTURE_STARTED')) {
    capture.error = 'server capture did not start';
    if (options.clientCapture) {
      clientCapture.error = 'skipped because server capture did not start';
    }
    note('FAIL: could not start tcpdump.');
    return;
  }
  capture.path =
    result.stdout.split(/\r?\n/).find((line) => line.startsWith('/tmp/')) || '';
  capture.startedAt = new Date().toISOString();
  if (options.clientCapture) startClientCapture();
  try {
    if (options.restartTelegram) {
      note('Restarting Telegram to generate fresh proxy connections...');
      command('osascript', ['-e', 'quit app "Telegram"']);
      awaitDelay(2000);
      command('open', ['-a', 'Telegram']);
      awaitDelay(2000);
    } else {
      note(
        '>>> Reconnect Telegram now or run --api-test to generate traffic. <<<'
      );
    }
    if (options.apiTest) apiResult = runApiTest();
    note(`Capturing for ${options.captureSeconds}s...`);
    awaitDelay(options.captureSeconds * 1000);
    note(`Analyzing ${capture.path}`);
    analyzeCapture(capture.path);
  } finally {
    stopClientCapture();
    if (options.clientCapture) analyzeClientCapture();
  }
  if (!options.keepPcap)
    remote(`rm -f ${sh(capture.path)} /tmp/mtproxy-diagnose-last.path`);
};

if (options.capture) startCapture();
if (options.apiTest && apiResult.status === 'skipped') apiResult = runApiTest();

const knownGood = { status: 'skipped', mismatches: 0, output: '' };
if (!remoteAvailable) {
  knownGood.output = 'KNOWN_GOOD_STATUS=skipped (remote unavailable)';
} else if (options.useKnownGood && existsSync(options.knownGoodFile)) {
  const kgArgs = ['compare', '--file', options.knownGoodFile];
  const add = (key, value) => {
    if (value !== '' && value !== undefined && value !== null)
      kgArgs.push(`--${key}`, String(value));
  };
  add('container', remoteState.container);
  add('image', remoteState.image);
  add('network', remoteState.network);
  add('restart', remoteState.restart);
  add('secret-sha', remoteState.secretSha);
  add('app-host', app.host);
  add('app-port', app.port);
  add('app-prefix', app.prefix);
  add('app-secret-sha', app.secretSha);
  add('mss-rules', remoteState.mssRules);
  add('mss-service', remoteState.mssService);
  add('dc2-main', remoteState.proxyDc2Main);
  add('dc2-media', remoteState.proxyDc2Media);
  add('media203', remoteState.proxyMedia203);
  const result = command(process.execPath, [
    join(scriptDir, 'scripts/mtproxy/known-good.mjs'),
    ...kgArgs,
  ]);
  knownGood.output = `${result.stdout}${result.stderr}`.trim();
}
if (knownGood.output) {
  note('\n-- known-good comparison --');
  note(knownGood.output);
  const status = knownGood.output.match(/^KNOWN_GOOD_STATUS=(.*)$/m);
  const mismatches = knownGood.output.match(/^KNOWN_GOOD_MISMATCHES=(.*)$/m);
  knownGood.status = status ? status[1] : 'unknown';
  knownGood.mismatches = mismatches ? Number(mismatches[1]) || 0 : 0;
}

const noResponseDelta = appLogDelta();
const newAppLogLines = appLogLines();
const finalMedia = media.dir
  ? snapshotMedia(media.dir)
  : { partial: media.partial, bytes: media.bytes, recent: media.recent };
media.finalPartial = finalMedia.partial;
media.finalBytes = finalMedia.bytes;
media.finalRecent = finalMedia.recent;
media.finalGrowth = Math.max(0, finalMedia.bytes - media.bytes);

if (newAppLogLines.length > 0) {
  section('Client app log delta');
  for (const line of newAppLogLines) note(`CLIENT ${line}`);
}

section('Automated checks');
if (remoteAvailable) {
  note(
    `SERVER container: ${remoteState.container} listening=${remoteState.listening} mss_rules=${remoteState.mssRules}`
  );
  note(
    `SERVER client conns: ${remoteState.client} (active=${remoteState.active} no_payload=${remoteState.noPayload}) dc=${remoteState.dc}`
  );
  note(
    `SERVER client bytes: received=${remoteState.bytesReceived} sent=${remoteState.bytesSent} server_sendq_max=${remoteState.sendqMax}`
  );
  note(
    `SERVER text path (dc2 main): connections=${remoteState.dc2Main} payload_carrying=${remoteState.dc2MainActive}`
  );
  note(
    `SERVER config: workers=${remoteState.workers || '?'} nofile=${remoteState.nofile || '?'} tcp_cc=${remoteState.tcpCongestion || '?'} proxy_conf_sha=${remoteState.proxyConfSha || '?'}`
  );
} else {
  note('SERVER remote: unavailable; server metrics omitted.');
}
note(
  `CLIENT known-good: status=${knownGood.status} mismatches=${knownGood.mismatches} file=${options.knownGoodFile}`
);
note(
  `CLIENT api test: status=${apiResult.status} media=${options.apiMedia ? 'requested' : 'no'} error=${apiResult.error || 'none'}`
);
note(`CLIENT app proxy: ${app.status} (prefix=${app.prefix || 'unknown'})`);
if (
  app.secretSha &&
  remoteState.secretSha &&
  remoteState.secretSha !== 'unknown'
) {
  note(
    `CLIENT app secret matches proxy secret: ${app.secretSha === remoteState.secretSha ? 'yes' : 'NO'}`
  );
}
note(
  `CLIENT app log: new_no_response=${noResponseDelta} historical_no_response=${app.noResponseTotal} resumes=${app.resumes}`
);
note(
  `CLIENT media: partial=${media.partial} partial_bytes=${media.bytes} growth=${media.growth}B final_growth=${media.finalGrowth}B recent_complete=${media.recent}`
);
if (options.capture) {
  if (capture.clientBytes || capture.proxyBytes) {
    note(
      `SERVER capture: client_bytes=${capture.clientBytes} proxy_bytes=${capture.proxyBytes} client_conns=${capture.clientConns} mss=${capture.mss || '?'}`
    );
    note(
      `SERVER capture: proxy_retransmits=${capture.proxyRetransmits} proxy_retransmit_bytes=${capture.proxyRetransmitBytes} proxy_ack_gap_max=${capture.proxyAckGapMax} proxy_rst=${capture.proxyRst}`
    );
  } else {
    note(`SERVER capture: unavailable (${capture.error || 'no server pcap'})`);
  }
}
if (clientCapture.ok) {
  note(
    `CLIENT capture: sent=${clientCapture.sentBytes} recv=${clientCapture.recvBytes} recv_retransmits=${clientCapture.recvRetransmits} recv_ack_gap_max=${clientCapture.recvAckGapMax} recv_rst=${clientCapture.recvRst}`
  );
} else {
  note(
    `CLIENT capture: unavailable (${clientCapture.error || 'not requested'})`
  );
}

let failed = false;
const hardFail = (message) => {
  note(`FAIL: ${message}`);
  failed = true;
};
if (!remoteAvailable) {
  hardFail('remote diagnostics unavailable; verification is incomplete.');
} else {
  if (remoteOutput.includes('container: MISSING'))
    hardFail('proxy container is missing.');
  if (remoteState.listening === 0)
    hardFail(`host port ${options.port} is not listening.`);
  if (remoteState.mssRules === 0)
    hardFail('no TCPMSS rules found; large packets may be blackholed.');
}
if (app.status === 'mismatch')
  hardFail(`Telegram app proxy does not match ${serverIp}:${options.port}.`);
if (
  app.status === 'match' &&
  app.secretSha &&
  remoteState.secretSha &&
  remoteState.secretSha !== 'unknown' &&
  app.secretSha !== remoteState.secretSha
) {
  hardFail("Telegram app secret does not match the proxy's /data/secret.");
}
if (remoteAvailable && knownGood.status === 'FAIL')
  hardFail(
    `configuration differs from ${options.knownGoodFile} (${knownGood.mismatches} mismatch(es)).`
  );
if (options.apiTest && apiResult.status !== 'PASS') {
  if (!remoteAvailable && /proxy secret/i.test(apiResult.error || '')) {
    note(
      'WARN: API test could not run because the proxy secret needs remote access.'
    );
  } else {
    hardFail('Telegram API test did not pass.');
  }
}
if (remoteState.client > 0 && remoteState.dc === 0)
  hardFail('clients connect but the proxy has no Telegram DC connections.');
if (remoteState.type !== 'mtg' && remoteState.client > 0) {
  if (remoteState.dc2Main === 0)
    hardFail(
      'no upstream connection to DC2 main (149.154.161.144:8888); text messages cannot flow.'
    );
  else if (apiResult.status === 'PASS')
    note(
      'PASS: Telegram API text path passed (DC2 snapshot may predate the API test).'
    );
  else if (remoteState.dc2MainActive === 0)
    note('WARN: DC2 main upstream exists but has not carried payload yet.');
  else
    note(
      `PASS: DC2 main (text path) has ${remoteState.dc2MainActive} payload-carrying upstream connection(s).`
    );
}
if (remoteState.noPayload > 0 && remoteState.active === 0) {
  if (options.capture && capture.clientBytes > 0)
    note('WARN: socket snapshot preceded fresh payload; capture proves flow.');
  else
    hardFail(
      'all client connections are handshake-only; no client payload is reaching the proxy.'
    );
}
if (remoteState.sendqMax > 100000) {
  if (remoteState.active > 0 || (options.capture && capture.proxyBytes > 0)) {
    note(
      `WARN: ${remoteState.sendqMax} bytes queued on a few connections while others carry payload.`
    );
  } else {
    hardFail(
      `proxy has ${remoteState.sendqMax} bytes queued to clients (PMTU/proxy stall).`
    );
  }
}
if (options.capture) {
  if (capture.clientBytes === 0 && capture.clientConns > 0)
    hardFail('capture shows handshakes but zero client payload.');
  else if (capture.clientBytes >= 64 && capture.proxyBytes === 0)
    hardFail('capture shows client payload but zero proxy response.');
  else if (capture.clientBytes > 0 && capture.clientBytes < 64)
    note(`INFO: capture only saw a ${capture.clientBytes}-byte probe.`);
  else if (capture.clientBytes > 0 && capture.proxyBytes > 0) {
    note(
      `PASS: capture saw bidirectional payload (client=${capture.clientBytes} proxy=${capture.proxyBytes} bytes).`
    );
  }
  if (capture.proxyRetransmits > 0 || capture.proxyAckGapMax > 0) {
    note(
      `FAIL: server capture shows proxy->client loss (retransmits=${capture.proxyRetransmits} ack_gap_max=${capture.proxyAckGapMax}).`
    );
  }
}
if (options.clientCapture && !clientCapture.ok) {
  note(
    `WARN: client capture unavailable: ${clientCapture.error || 'no pcap written'}`
  );
}
if (noResponseDelta > 0)
  note(
    `WARN: app log gained ${noResponseDelta} transport error line(s) during this run.`
  );
else note('PASS: no new app transport errors were logged during this run.');
if (media.growth > 0)
  note(
    `PASS: partial media is growing (${media.growth} bytes in ${options.mediaSeconds}s).`
  );
else if (media.recent > 0)
  note(`PASS: ${media.recent} completed media file(s) in the last 30m.`);

section('Client/server comparison');
note(
  `CLIENT proxy endpoint: ${app.host || 'unknown'}:${app.port || 'unknown'} secret_sha=${app.secretSha || 'unknown'}`
);
note(
  `CLIENT app_no_response_new=${noResponseDelta} historical=${app.noResponseTotal} resumes=${app.resumes}`
);
if (remoteAvailable) {
  note(
    `SERVER proxy endpoint: ${serverIp}:${options.port} secret_sha=${remoteState.secretSha || 'unknown'}`
  );
  note(
    `SERVER clients=${remoteState.client} active=${remoteState.active} no_payload=${remoteState.noPayload} dc=${remoteState.dc}`
  );
  note(
    `SERVER service_bytes: rx=${remoteState.bytesReceived} tx=${remoteState.bytesSent} sendq_max=${remoteState.sendqMax}`
  );
  if (options.capture) {
    note(
      `SERVER capture_bytes: rx=${capture.clientBytes} tx=${capture.proxyBytes}`
    );
    note(
      `SERVER capture_loss: tx_retransmits=${capture.proxyRetransmits} tx_retransmit_bytes=${capture.proxyRetransmitBytes} ack_gap_max=${capture.proxyAckGapMax} tx_rst=${capture.proxyRst}`
    );
  }
} else {
  note('SERVER remote: unavailable; no server comparison values.');
}
if (clientCapture.ok) {
  note(
    `CLIENT capture_bytes: tx=${clientCapture.sentBytes} rx=${clientCapture.recvBytes}`
  );
  note(
    `CLIENT capture_loss: rx_retransmits=${clientCapture.recvRetransmits} rx_retransmit_bytes=${clientCapture.recvRetransmitBytes} ack_gap_max=${clientCapture.recvAckGapMax} rx_rst=${clientCapture.recvRst}`
  );
  if (options.capture) {
    note(
      `COMPARE client_tx_minus_server_rx=${clientCapture.sentBytes - capture.clientBytes}`
    );
    note(
      `COMPARE server_tx_minus_client_rx=${capture.proxyBytes - clientCapture.recvBytes}`
    );
  }
} else {
  note(`CLIENT capture_bytes: unavailable`);
}
note(
  `COMPARE api_status=${apiResult.status} app_log_new_no_response=${noResponseDelta} server_tx_retransmits=${remoteAvailable ? capture.proxyRetransmits : 'unavailable'}`
);

const summary = {
  schema: 1,
  runId,
  startedAt,
  finishedAt: new Date().toISOString(),
  client: {
    publicIp,
    route: { interface: clientInterface, gateway: routeGateway },
    app: {
      status: app.status,
      host: app.host,
      port: app.port,
      prefix: app.prefix,
      secretSha: app.secretSha,
      logPath: app.logPath,
      noResponseNew: noResponseDelta,
      noResponseTotal: app.noResponseTotal,
      resumes: app.resumes,
      newErrorLines: newAppLogLines,
    },
    sockets: {
      established: local.estab,
      sendqMax: local.sendqMax,
      recvqMax: local.recvqMax,
    },
    media: {
      partial: media.partial,
      bytes: media.bytes,
      growth: media.growth,
      finalPartial: media.finalPartial,
      finalBytes: media.finalBytes,
      finalGrowth: media.finalGrowth,
      recent: media.recent,
      finalRecent: media.finalRecent,
    },
    api: { status: apiResult.status, error: apiResult.error },
    capture: clientCapture,
  },
  server: {
    available: remoteAvailable,
    ip: serverIp,
    port: Number(options.port),
    container: remoteState.container,
    image: remoteState.image,
    imageId: remoteState.imageId,
    running: remoteState.running,
    type: remoteState.type,
    network: remoteState.network,
    restart: remoteState.restart,
    workers: remoteState.workers,
    nofile: remoteState.nofile,
    hostNofile: remoteState.hostNofile,
    containerNofile: remoteState.containerNofile,
    tcpCongestion: remoteState.tcpCongestion,
    proxyConfSha: remoteState.proxyConfSha,
    secretSha: remoteState.secretSha,
    listening: remoteState.listening,
    mssRules: remoteState.mssRules,
    mssService: remoteState.mssService,
    clientConns: remoteState.client,
    active: remoteState.active,
    noPayload: remoteState.noPayload,
    dc: remoteState.dc,
    other443: remoteState.other443,
    sendqMax: remoteState.sendqMax,
    bytesReceived: remoteState.bytesReceived,
    bytesSent: remoteState.bytesSent,
    dc2Main: remoteState.dc2Main,
    dc2MainActive: remoteState.dc2MainActive,
    capture,
  },
  knownGood,
  result: {
    status: !remoteAvailable ? 'BLOCKED' : failed ? 'FAIL' : 'PASS',
  },
};

if (summaryFile) {
  writeFileSync(summaryFile, `${JSON.stringify(summary, null, 2)}\n`);
  note(`Summary JSON: ${summaryFile}`);
}

if (options.compareFile) {
  section(`Comparison with ${options.compareFile}`);
  if (!summaryFile) {
    note(
      'FAIL: --compare requires a report directory; do not use --no-report.'
    );
  } else if (!existsSync(options.compareFile)) {
    note(`FAIL: cannot read comparison summary ${options.compareFile}`);
  } else {
    const compare = command(
      process.execPath,
      [
        join(scriptDir, 'scripts/mtproxy/compare-summary.mjs'),
        options.compareFile,
        summaryFile,
      ],
      { maxBuffer: 16 * 1024 * 1024 }
    );
    note(`${compare.stdout}${compare.stderr}`.trim());
  }
}

section('Result');
if (!remoteAvailable)
  note(
    'BLOCKED: remote diagnostics were unavailable; verification is incomplete.'
  );
else if (!failed) note('PASS: automated checks found no hard failures.');
else
  note('FAIL: automated checks found one or more hard failures (see above).');
note(`Report: ${reportFile || 'disabled'}`);
note(
  'Use --api-test or --api-media for protocol-level checks without the visual app.'
);
if (options.strict && failed) process.exitCode = 1;
