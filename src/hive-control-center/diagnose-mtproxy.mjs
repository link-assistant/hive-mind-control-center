#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
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
  clientIp: value('MTPROXY_CLIENT_IP'),
  keepPcap: false,
  restartTelegram: false,
  strict: false,
  noReport: false,
  mediaSeconds: Number(value('MTPROXY_MEDIA_SECONDS', '8')),
  reportDir: value('MTPROXY_REPORT_DIR', join(scriptDir, 'data/diagnostics')),
  lenvFile: value('LENV_FILE', join(scriptDir, '.lenv')),
  knownGoodFile: value('MTPROXY_KNOWN_GOOD', join(scriptDir, 'scripts/mtproxy/known-good.json')),
  useKnownGood: true,
  apiTest: false,
  apiMedia: false,
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
  --client-ip <ip>           Restrict pcap analysis to one client IP
  --keep-pcap                Keep the remote pcap and print its path
  --restart-telegram         Restart the macOS Telegram app before capture
  --strict                   Exit non-zero on hard failures
  --no-report                Do not write a timestamped report
  --media-seconds <n>        Sample partial media for n seconds (default: 8)
  --report-dir <path>        Report directory
  --lenv <path>              Path to .lenv (default: ./.lenv)
  --known-good <path>        Known-good profile
  --no-known-good            Skip known-good comparison
  --api-test                 Send and verify a marker through MTProto
  --api-media                Also upload and download a small document through MTProto
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
  else if (arg === '--client-ip') options.clientIp = next();
  else if (arg === '--keep-pcap') options.keepPcap = true;
  else if (arg === '--restart-telegram') options.restartTelegram = true;
  else if (arg === '--strict') options.strict = true;
  else if (arg === '--no-report') options.noReport = true;
  else if (arg === '--media-seconds') options.mediaSeconds = Number(next());
  else if (arg === '--report-dir') options.reportDir = next();
  else if (arg === '--lenv') options.lenvFile = next();
  else if (arg === '--known-good') {
    options.knownGoodFile = next();
    options.useKnownGood = true;
  } else if (arg === '--no-known-good') options.useKnownGood = false;
  else if (arg === '--api-test') options.apiTest = true;
  else if (arg === '--api-media') {
    options.apiTest = true;
    options.apiMedia = true;
  }
  else if (arg === '--telegram-env') options.telegramEnvFile = next();
  else if (arg === '--telegram-session') options.telegramSessionFile = next();
  else failUsage(`unknown option: ${arg}`);
}

options.container ||= `mtproxy-classic-${options.port}`;
if (!/^[0-9]+$/.test(options.port) || Number(options.port) < 1 || Number(options.port) > 65535) {
  failUsage(`invalid --port: ${options.port}`);
}
if (!Number.isInteger(options.captureSeconds) || options.captureSeconds < 5) {
  failUsage(`invalid --capture-seconds: ${options.captureSeconds}`);
}
if (!Number.isInteger(options.mediaSeconds) || options.mediaSeconds < 0 || options.mediaSeconds > 120) {
  failUsage(`invalid --media-seconds: ${options.mediaSeconds}`);
}
if (!existsSync(options.lenvFile)) failUsage(`cannot read ${options.lenvFile}`);
if (options.apiTest && !options.telegramEnvFile) {
  failUsage('--api-test requires --telegram-env or TELEGRAM_ENV_FILE');
}
if (options.apiTest && !existsSync(options.telegramEnvFile)) {
  failUsage(`cannot read ${options.telegramEnvFile}`);
}
options.telegramSessionFile ||= join(dirname(options.telegramEnvFile || options.lenvFile), '.telegram_session');

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
if (!serverIp || !serverPass) failUsage('SERVER_IP and SERVER_PASS must be set in the .lenv file');
if (spawnSync('which', ['sshpass']).status !== 0) failUsage('sshpass is required (brew install hudochenkov/sshpass/sshpass).');
options.port = String(options.port);

let reportFile = '';
if (!options.noReport) {
  mkdirSync(options.reportDir, { recursive: true });
  const stamp = new Date().toISOString().replaceAll(/[:.]/g, '-').replace('T', '-').replace('Z', '');
  reportFile = join(options.reportDir, `mtproxy-${stamp}.log`);
  appendFileSync(reportFile, '');
}

const note = (line = '') => {
  process.stdout.write(`${line}\n`);
  if (reportFile) appendFileSync(reportFile, `${line}\n`);
};
const section = (title) => note(`\n== ${title} ==`);
const sh = (text) => `'${String(text).replaceAll("'", `'\\''`)}'`;
const command = (cmd, cmdArgs, { input, env, maxBuffer = 64 * 1024 * 1024, encoding = 'utf8', timeout = 0 } = {}) =>
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
const remote = (remoteCommand, { input, encoding = 'utf8', timeout = 60000 } = {}) =>
  command(
    'sshpass',
    ['-e', 'ssh', ...sshOptions, `${serverUser}@${serverIp}`, remoteCommand],
    { input, env: { SSHPASS: serverPass }, maxBuffer: 256 * 1024 * 1024, encoding, timeout },
  );

const publicIp = (() => {
  const result = command('curl', ['-4', '-fsS', '--max-time', '5', 'https://api.ipify.org']);
  return result.status === 0 ? result.stdout.trim() : '';
})();

const group = join(
  homedir(),
  'Library/Group Containers/6N38VWS5BX.ru.keepcoder.Telegram/appstore',
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
  const result = command(process.execPath, [join(scriptDir, 'scripts/mtproxy/app-config.mjs'), appConfigFile]);
  const lines = Object.fromEntries(
    result.stdout
      .split(/\r?\n/)
      .map((line) => line.split('='))
      .filter(([key]) => key),
  );
  app.status = lines.status || 'unknown';
  app.host = lines.host || '';
  app.port = lines.port || '';
  app.prefix = lines.prefix || '';
  app.secretSha = lines.sha || '';
  if (app.status === 'ok' && app.host === serverIp && app.port === options.port) app.status = 'match';
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
  app.noResponseTotal = (text.match(/no response|invalidating the transport|connection.*stuck/gi) || []).length;
  const tail = text.slice(-400000);
  app.resumes = (tail.match(/resume|reconnect|transport.*restart/gi) || []).length;
}

const appLogDelta = () => {
  if (!app.logPath) return 0;
  const buffer = readFileSync(app.logPath);
  return (buffer.subarray(app.logBaseline).toString('latin1').match(/no response|invalidating the transport|connection.*stuck/gi) || [])
    .length;
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
      } else if (stat.size > 100 * 1024 && Date.now() - stat.mtimeMs < 30 * 60 * 1000) {
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
  await new Promise((resolveDelay) => setTimeout(resolveDelay, options.mediaSeconds * 1000));
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
note(`report: ${reportFile || 'disabled'}`);

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
  .filter((line) => new RegExp(`[.]${options.port}\\s`).test(line) && line.includes(serverIp));
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
  note(`established sockets: ${local.estab}; max Send-Q: ${local.sendqMax}; max Recv-Q: ${local.recvqMax}`);
  if (local.sendqMax > 0) {
    local.sendq = true;
    note('INFO: local Send-Q is non-zero (normal during transfer; compare with remote payload).');
  }
}

section('Proxy TCP reachability');
const ncResult = command('nc', ['-vz', '-G', '5', serverIp, options.port]);
local.tcpReachable = ncResult.status === 0;
note(`${local.tcpReachable ? 'PASS' : 'FAIL'}: TCP ${serverIp}:${options.port} ${local.tcpReachable ? 'is' : 'is not'} reachable`);

section('Direct Telegram DC reachability');
for (const dc of ['149.154.167.41:443', '91.108.56.130:443', '149.154.175.50:443']) {
  const [host, port] = dc.split(':');
  const reachable = command('nc', ['-vz', '-G', '5', host, port]).status === 0;
  local.direct.push({ dc, reachable });
  note(`${reachable ? 'PASS' : 'FAIL'}: direct ${dc}`);
}

section('Path MTU to proxy');
let maxOk = 0;
for (const size of [1472, 1464, 1450, 1440, 1420, 1400, 1380, 1300, 1200, 1100]) {
  const ok = command('ping', ['-D', '-s', String(size), '-c', '2', '-W', '1000', serverIp]).status === 0;
  local.pmtu.push({ size, ok });
  if (ok) maxOk = Math.max(maxOk, size);
  note(`${ok ? 'PASS' : 'FAIL'}: payload ${size} (MTU ${size + 28})`);
}
if (maxOk) {
  note(`max working IPv4 payload: ${maxOk} (MTU ${maxOk + 28})`);
  if (maxOk < 1472) note('WARN: path MTU is below 1500; large ClientHello segments may be dropped.');
} else {
  note('FAIL: no tested payload size succeeded');
}

const remoteScript = `set -u
echo "host: $(hostname)"
echo "date: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
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
PID="$(docker inspect -f '{{.State.Pid}}' "$CONTAINER" 2>/dev/null || true)"
echo "pid=${'$'}{PID:-unknown}"
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
  echo "proxy_dc2_main=$(grep -c '^proxy_for 2 149\\.154\\.161\\.144:8888;' "$CONF_FILE" 2>/dev/null || true)"
  echo "proxy_dc2_media=$(grep -c '^proxy_for -2 149\\.154\\.161\\.184:8888;' "$CONF_FILE" 2>/dev/null || true)"
  echo "proxy_media203=$(grep -c '^proxy_for -203 91\\.105\\.192\\.110:443;' "$CONF_FILE" 2>/dev/null || true)"
else
  echo "proxy_dc2_main=0"; echo "proxy_dc2_media=0"; echo "proxy_media203=0"
fi
case "$IMAGE" in *mtg*) PROXY_TYPE="mtg" ;; *) PROXY_TYPE="mtproto-proxy/classic" ;; esac
echo; echo "-- proxy type --"; echo "$PROXY_TYPE"
echo; echo "-- recent logs --"
docker logs --since 15m "$CONTAINER" 2>&1 | tail -120 | sed -E 's/(secret[[:space:]]*[=:][[:space:]]*)[^[:space:]]+/\\1REDACTED/Ig' || true
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
echo; echo "-- TCPMSS rules --"; iptables -t mangle -S 2>/dev/null | grep -i mss || true; iptables -S 2>/dev/null | grep -i mss || true; nft list ruleset 2>/dev/null | grep -i mss || true
echo; echo "-- mtg doctor --"
if [ "$PROXY_TYPE" = "mtg" ]; then docker exec "$CONTAINER" /mtg doctor /config.toml 2>&1 | tail -100 || true; else echo "not applicable (classic mtproto-proxy)"; fi`;

const remoteResult = remote(`PORT=${sh(options.port)} CONTAINER=${sh(options.container)} bash -s`, {
  input: remoteScript,
});
const remoteOutput = remoteResult.stdout || '';
const remoteError = remoteResult.stderr || '';
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
  network: metricText('network_mode'),
  restart: metricText('restart_policy'),
  mssService: metricText('mss_service'),
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
  type: remoteOutput.includes('mtproto-proxy/classic') ? 'classic' : remoteOutput.includes('mtg') ? 'mtg' : '',
};
if (!remoteOutput.trim()) note('FAIL: remote diagnostics returned no output.');

if (remoteState.pid && remoteState.pid !== 'unknown' && remoteState.pid !== '0') {
  const ss = remote(`nsenter -t ${sh(remoteState.pid)} -n ss -tinH state established 2>/dev/null`);
  if (ss.stdout.trim()) {
    const summary = command(process.execPath, [join(scriptDir, 'scripts/mtproxy/ss-tin.mjs'), '--port', options.port], {
      input: ss.stdout,
    });
    if (summary.stdout.trim()) {
      note('\n-- socket payload summary --');
      note(summary.stdout.trim());
      for (const line of summary.stdout.trim().split(/\s+/)) {
        const [key, metricValue] = line.split('=');
        if (!key) continue;
        if (key === 'client_no_payload') remoteState.noPayload = Number(metricValue) || 0;
        if (key === 'client_active') remoteState.active = Number(metricValue) || 0;
        if (key === 'client_bytes_received') remoteState.bytesReceived = Number(metricValue) || 0;
        if (key === 'client_bytes_sent') remoteState.bytesSent = Number(metricValue) || 0;
      }
    }
  }
}

let capture = { clientBytes: 0, proxyBytes: 0, clientConns: 0, mss: '', path: '' };
const analyzeCapture = (path) => {
  const raw = remote(`cat ${sh(path)}`, { encoding: null, timeout: 120000 });
  const result = command(process.execPath, [join(scriptDir, 'scripts/mtproxy/pcap.mjs'), '--port', options.port, '--client', options.clientIp || publicIp], {
    input: raw.stdout,
    maxBuffer: 512 * 1024 * 1024,
  });
  note(result.stdout.trim());
  const field = (key) => {
    const match = result.stdout.match(new RegExp(`^${key}=(.*)$`, 'm'));
    return match ? match[1] : '';
  };
  capture.clientBytes = Number(field('CAPTURE_CLIENT_BYTES')) || 0;
  capture.proxyBytes = Number(field('CAPTURE_PROXY_BYTES')) || 0;
  capture.clientConns = Number(field('CAPTURE_CLIENT_CONNS')) || 0;
  capture.mss = field('CAPTURE_MSS');
};
let apiResult = { status: 'skipped', output: '' };
const runApiTest = () => {
  const result = { status: 'skipped', output: '' };
  section('Telegram API test');
  const secretResult = remote(`docker exec ${sh(remoteState.container)} sh -c 'cat /data/secret 2>/dev/null'`);
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
    ],
    { env: { MTPROXY_SECRET_KEY: secretKey } },
  );
  result.output = `${api.stdout}${api.stderr}`.trim();
  note(result.output);
  const status = result.output.match(/^API_TEST_STATUS=(.*)$/m);
  result.status = status ? status[1] : 'FAIL';
  return result;
};

const startCapture = () => {
  section('Packet capture');
  note(`Starting a ${options.captureSeconds}s tcpdump on the server.`);
  const result = remote(`PORT=${sh(options.port)} SECONDS=${sh(String(options.captureSeconds))} bash -s`, {
    input: `set -u
CAP="/tmp/mtproxy-diagnose-$(date +%s).pcap"
rm -f /tmp/mtproxy-diagnose-last.path
nohup timeout "$SECONDS" tcpdump -i any -nn -s0 -U -w "$CAP" "tcp port $PORT" >/tmp/mtproxy-diagnose-tcpdump.log 2>&1 &
printf '%s\\n' "$CAP" > /tmp/mtproxy-diagnose-last.path
echo "$CAP"
sleep 1
if kill -0 $! 2>/dev/null; then echo "CAPTURE_STARTED"; else echo "CAPTURE_FAILED"; cat /tmp/mtproxy-diagnose-tcpdump.log; fi`,
  });
  note(result.stdout.trim());
  if (!result.stdout.includes('CAPTURE_STARTED')) {
    note('FAIL: could not start tcpdump.');
    return;
  }
  capture.path = result.stdout.split(/\r?\n/).find((line) => line.startsWith('/tmp/')) || '';
  if (options.restartTelegram) {
    note('Restarting Telegram to generate fresh proxy connections...');
    command('osascript', ['-e', 'quit app "Telegram"']);
    awaitDelay(2000);
    command('open', ['-a', 'Telegram']);
    awaitDelay(2000);
  } else {
    note('>>> Reconnect Telegram now or run --api-test to generate traffic. <<<');
  }
  if (options.apiTest) apiResult = runApiTest();
  note(`Capturing for ${options.captureSeconds}s...`);
  awaitDelay(options.captureSeconds * 1000);
  note(`Analyzing ${capture.path}`);
  analyzeCapture(capture.path);
  if (!options.keepPcap) remote(`rm -f ${sh(capture.path)} /tmp/mtproxy-diagnose-last.path`);
};

const awaitDelay = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

if (options.capture) startCapture();
if (options.apiTest && apiResult.status === 'skipped') apiResult = runApiTest();

const knownGood = { status: 'skipped', mismatches: 0, output: '' };
if (options.useKnownGood && existsSync(options.knownGoodFile)) {
  const kgArgs = ['compare', '--file', options.knownGoodFile];
  const add = (key, value) => {
    if (value !== '' && value !== undefined && value !== null) kgArgs.push(`--${key}`, String(value));
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
  const result = command(process.execPath, [join(scriptDir, 'scripts/mtproxy/known-good.mjs'), ...kgArgs]);
  knownGood.output = `${result.stdout}${result.stderr}`.trim();
  note('\n-- known-good comparison --');
  note(knownGood.output);
  const status = knownGood.output.match(/^KNOWN_GOOD_STATUS=(.*)$/m);
  const mismatches = knownGood.output.match(/^KNOWN_GOOD_MISMATCHES=(.*)$/m);
  knownGood.status = status ? status[1] : 'unknown';
  knownGood.mismatches = mismatches ? Number(mismatches[1]) || 0 : 0;
}

const noResponseDelta = appLogDelta();
section('Automated checks');
note(`container: ${remoteState.container} listening=${remoteState.listening} mss_rules=${remoteState.mssRules}`);
note(`client conns: ${remoteState.client} (active=${remoteState.active} no_payload=${remoteState.noPayload}) dc=${remoteState.dc}`);
note(`client bytes: received=${remoteState.bytesReceived} sent=${remoteState.bytesSent} server_sendq_max=${remoteState.sendqMax}`);
note(`text path (dc2 main): connections=${remoteState.dc2Main} payload_carrying=${remoteState.dc2MainActive}`);
note(`known-good: status=${knownGood.status} mismatches=${knownGood.mismatches} file=${options.knownGoodFile}`);
note(`api test: status=${apiResult.status} media=${options.apiMedia ? 'requested' : 'no'}${apiResult.status === 'PASS' ? '' : ' (use --api-test with Telegram credentials)'}`);
note(`app proxy: ${app.status} (prefix=${app.prefix || 'unknown'})`);
if (app.secretSha && remoteState.secretSha && remoteState.secretSha !== 'unknown') {
  note(`app secret matches proxy secret: ${app.secretSha === remoteState.secretSha ? 'yes' : 'NO'}`);
}
note(`app log: new_no_response=${noResponseDelta} historical_no_response=${app.noResponseTotal} resumes=${app.resumes}`);
note(`media: partial=${media.partial} partial_bytes=${media.bytes} growth=${media.growth}B recent_complete=${media.recent}`);
if (options.capture) {
  note(`capture: client_bytes=${capture.clientBytes} proxy_bytes=${capture.proxyBytes} client_conns=${capture.clientConns} mss=${capture.mss || '?'}`);
}

let failed = false;
const hardFail = (message) => {
  note(`FAIL: ${message}`);
  failed = true;
};
if (remoteOutput.includes('container: MISSING')) hardFail('proxy container is missing.');
if (remoteState.listening === 0) hardFail(`host port ${options.port} is not listening.`);
if (remoteState.mssRules === 0) hardFail('no TCPMSS rules found; large packets may be blackholed.');
if (app.status === 'mismatch') hardFail(`Telegram app proxy does not match ${serverIp}:${options.port}.`);
if (app.status === 'match' && app.secretSha && remoteState.secretSha && remoteState.secretSha !== 'unknown' && app.secretSha !== remoteState.secretSha) {
  hardFail("Telegram app secret does not match the proxy's /data/secret.");
}
if (knownGood.status === 'FAIL') hardFail(`configuration differs from ${options.knownGoodFile} (${knownGood.mismatches} mismatch(es)).`);
if (options.apiTest && apiResult.status !== 'PASS') hardFail('Telegram API test did not pass.');
if (remoteState.client > 0 && remoteState.dc === 0) hardFail('clients connect but the proxy has no Telegram DC connections.');
if (remoteState.type !== 'mtg' && remoteState.client > 0) {
  if (remoteState.dc2Main === 0) hardFail('no upstream connection to DC2 main (149.154.161.144:8888); text messages cannot flow.');
  else if (apiResult.status === 'PASS') note('PASS: Telegram API text path passed (DC2 snapshot may predate the API test).');
  else if (remoteState.dc2MainActive === 0) note('WARN: DC2 main upstream exists but has not carried payload yet.');
  else note(`PASS: DC2 main (text path) has ${remoteState.dc2MainActive} payload-carrying upstream connection(s).`);
}
if (remoteState.noPayload > 0 && remoteState.active === 0) {
  if (options.capture && capture.clientBytes > 0) note('WARN: socket snapshot preceded fresh payload; capture proves flow.');
  else hardFail('all client connections are handshake-only; no client payload is reaching the proxy.');
}
if (remoteState.sendqMax > 100000) {
  if (remoteState.active > 0 || (options.capture && capture.proxyBytes > 0)) {
    note(`WARN: ${remoteState.sendqMax} bytes queued on a few connections while others carry payload.`);
  } else {
    hardFail(`proxy has ${remoteState.sendqMax} bytes queued to clients (PMTU/proxy stall).`);
  }
}
if (options.capture) {
  if (capture.clientBytes === 0 && capture.clientConns > 0) hardFail('capture shows handshakes but zero client payload.');
  else if (capture.clientBytes >= 64 && capture.proxyBytes === 0) hardFail('capture shows client payload but zero proxy response.');
  else if (capture.clientBytes > 0 && capture.clientBytes < 64) note(`INFO: capture only saw a ${capture.clientBytes}-byte probe.`);
  else if (capture.clientBytes > 0 && capture.proxyBytes > 0) {
    note(`PASS: capture saw bidirectional payload (client=${capture.clientBytes} proxy=${capture.proxyBytes} bytes).`);
  }
}
if (noResponseDelta > 0) note(`WARN: app log gained ${noResponseDelta} transport error line(s) during this run.`);
else note('PASS: no new app transport errors were logged during this run.');
if (media.growth > 0) note(`PASS: partial media is growing (${media.growth} bytes in ${options.mediaSeconds}s).`);
else if (media.recent > 0) note(`PASS: ${media.recent} completed media file(s) in the last 30m.`);

section('Result');
if (!failed) note('PASS: automated checks found no hard failures.');
else note('FAIL: automated checks found one or more hard failures (see above).');
note(`Report: ${reportFile || 'disabled'}`);
note('Use --api-test or --api-media for protocol-level checks without the visual app.');
if (options.strict && failed) process.exitCode = 1;
