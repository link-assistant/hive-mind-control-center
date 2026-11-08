#!/usr/bin/env node

const { use } = eval(
  await fetch('https://unpkg.com/use-m@8.16.4/use.js').then((u) => u.text())
);

// Versions are pinned on purpose: an unpinned `command-stream` silently picked
// up 2.0.0 (Node >=22, node-pty without linux-x64 prebuilds) and broke deploys
// on Node 20 hosts without a build toolchain (link-foundation/command-stream#218).
// Workaround for link-foundation/use-m#78: that failed install deleted the
// `command-stream-v-latest` alias but left its bin symlink dangling, so every
// later alias install died with EEXIST. Drop such a dead link before use().
await (async () => {
  const { execSync } = await import('node:child_process');
  const { lstatSync, existsSync, readlinkSync, unlinkSync } = await import('node:fs');
  const { join } = await import('node:path');
  try {
    const prefix = execSync('npm prefix -g', { encoding: 'utf8' }).trim();
    const bin = join(prefix, process.platform === 'win32' ? '' : 'bin', 'command-stream');
    if (lstatSync(bin).isSymbolicLink() && !existsSync(bin)
        && readlinkSync(bin).includes('command-stream-v-')) {
      unlinkSync(bin);
    }
  } catch {}
})();

const { $ } = await use('command-stream@1.6.2');
const { makeConfig } = await use('lino-arguments@0.3.0');

// Load configuration from .lenv (makeConfig for single values + CLI args)
const config = makeConfig({
  yargs: ({ yargs, getenv }) =>
    yargs
      .version(false)
      .help(false)
      .option('server-ip', { default: getenv('SERVER_IP') })
      .option('server-user', { default: getenv('SERVER_USER') })
      .option('server-pass', { default: getenv('SERVER_PASS') })
      .option('verbose', { type: 'boolean', default: false, description: 'Enable verbose debug output' })
      .option('dangerously-show-secrets', { type: 'boolean', default: false, description: 'Show secret values in debug output' }),
});

const VERBOSE = config.verbose;
const SHOW_SECRETS = config.dangerouslyShowSecrets;

const mask = (value) => SHOW_SECRETS ? value : '***';
const log = (...args) => { if (VERBOSE) console.log('[DEBUG]', ...args); };

const IP = config.serverIp;
const USER = config.serverUser;
const PASS = config.serverPass;
const CONTAINER = 'hive-mind';

// Validate required config
const missing = [];
if (!IP) missing.push('SERVER_IP');
if (!USER) missing.push('SERVER_USER');
if (!PASS) missing.push('SERVER_PASS');
if (missing.length) {
  console.error(`>>> ERROR: Missing required .lenv values: ${missing.join(', ')}`);
  process.exit(1);
}

const SSH_OPTS = '-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=10';

// Helper function to sleep
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// sshpass exit codes:
// 1 - Invalid arguments
// 2 - Conflicting arguments
// 3 - General runtime error
// 5 - Invalid/incorrect password
// 6 - Host public key is unknown (strict host checking)
const handleSshError = (error) => {
  const code = error.code ?? error.exitCode;
  if (code === 5) {
    console.error('>>> ERROR: Invalid password. Check SERVER_PASS in .lenv');
    process.exit(1);
  }
  if (code === 6) {
    console.error('>>> ERROR: Unknown host key. Check SERVER_IP in .lenv');
    process.exit(1);
  }
  if (code === 255) {
    log('SSH connection refused or unreachable (code 255)');
  }
  return code;
};

// Helper to run SSH commands and print reproducible command
const ssh = async (command, { silent = false, ignoreErrors = false } = {}) => {
  if (!silent) {
    console.log(`>>> sshpass -p '${mask(PASS)}' ssh ${SSH_OPTS} ${USER}@${IP} ${command}`);
  }
  try {
    const result = await $`sshpass -p ${PASS} ssh ${SSH_OPTS.split(' ')} ${USER}@${IP} ${command}`;
    log(`Exit code: ${result.code}`);
    return result;
  } catch (error) {
    log(`Command failed (code ${error.code}):`, error.message || error);
    handleSshError(error);
    if (!ignoreErrors) throw error;
  }
};

// Helper to run a command inside the container via bash
const dockerSh = (command, opts) => ssh(`docker exec ${CONTAINER} bash -i -c '${command}'`, opts);

// Helper to check SSH availability
const checkSshAvailable = async () => {
  const sshTarget = `${USER}@${IP}`;
  log(`Checking SSH to ${sshTarget}...`);
  try {
    const result = await $({ mirror: false })`sshpass -p ${PASS} ssh ${SSH_OPTS.split(' ')} ${sshTarget} echo up`;
    log(`SSH check stdout: ${result.stdout}`);
    log(`SSH check code: ${result.code}`);
    return result.code === 0;
  } catch (error) {
    const code = error.code ?? error.exitCode;
    log(`SSH check failed (code ${code}): ${error.message || error}`);
    if (code === 5) {
      console.error('>>> ERROR: Invalid password. Check SERVER_PASS in .lenv');
      process.exit(1);
    }
    if (code === 6) {
      console.error('>>> ERROR: Unknown host key. Check SERVER_IP in .lenv');
      process.exit(1);
    }
    return false;
  }
};

// Helper to get container status
const getContainerStatus = async () => {
  try {
    const result = await $({ mirror: false })`sshpass -p ${PASS} ssh ${SSH_OPTS.split(' ')} ${USER}@${IP} docker inspect -f {{.State.Status}} ${CONTAINER}`;
    return result.stdout.trim() || 'not_found';
  } catch {
    return 'not_found';
  }
};

// Main execution
let step = 0;
const nextStep = (msg) => console.log(`>>> Step ${++step}: ${msg}`);

nextStep('Checking SSH availability');
log(`IP=${IP}, USER=${USER}, PASS=${mask(PASS)}`);
log(`SSH_OPTS=${SSH_OPTS}`);
while (!(await checkSshAvailable())) {
  console.log('>>> SSH not available, retrying in 10s');
  await sleep(10000);
}
console.log('>>> Server is reachable');

nextStep('Checking container status');
let status = await getContainerStatus();
console.log(`>>> Container status: ${status}`);

if (status === 'not_found') {
  console.error('>>> ERROR: Container does not exist. Run docker-restart.mjs to create it.');
  process.exit(1);
}

if (status === 'exited' || status === 'created') {
  console.log('>>> Container is stopped, starting it...');
  await ssh(`docker start ${CONTAINER}`);
  await sleep(5000);
  status = await getContainerStatus();
  console.log(`>>> Container status after start: ${status}`);
}

if (status !== 'running') {
  console.error(`>>> ERROR: Container is in unexpected state: ${status}`);
  process.exit(1);
}

nextStep('Fixing /home/box/.local permissions for box user');
await ssh(`docker exec -u root ${CONTAINER} mkdir -p /home/box/.local/share /home/box/.local/state`);
await ssh(`docker exec -u root ${CONTAINER} chown -R box:box /home/box/.local`);

nextStep('Updating hive-mind');
await dockerSh('bun install -g @link-assistant/hive-mind@latest');

nextStep('Updating agent');
await dockerSh('bun install -g @link-assistant/agent@latest');

nextStep('Initializing Gemini CLI (run three times to create config)');
await dockerSh('gemini --version', { ignoreErrors: true });
await dockerSh('gemini --version', { ignoreErrors: true });
await dockerSh('gemini --version', { ignoreErrors: true });

nextStep('Restarting bot (killing current process, loop will restart it)');
await ssh(`docker exec ${CONTAINER} pkill -f hive-telegram-bot`, { ignoreErrors: true });

// Check if start-bot.sh is running (the loop that auto-restarts the bot)
await sleep(3000);
try {
  await $({ mirror: false })`sshpass -p ${PASS} ssh ${SSH_OPTS.split(' ')} ${USER}@${IP} docker exec ${CONTAINER} pgrep -f start-bot.sh`;
  console.log('>>> start-bot.sh loop is running, bot will auto-restart');
} catch {
  console.log('>>> start-bot.sh loop is not running, starting bot manually...');
  await ssh(`docker exec -d ${CONTAINER} bash -i -c 'bash /home/box/start-bot.sh'`);
}

nextStep('Waiting for bot to start and verifying');
const maxWait = 60000;
const pollInterval = 5000;
let elapsed = 0;
let botStarted = false;
while (elapsed < maxWait) {
  await sleep(pollInterval);
  elapsed += pollInterval;
  try {
    const logsResult = await $({ mirror: false })`sshpass -p ${PASS} ssh ${SSH_OPTS.split(' ')} ${USER}@${IP} docker logs --tail 50 ${CONTAINER}`;
    const logs = logsResult.stdout;
    if (logs.includes('starting polling...')) {
      botStarted = true;
      break;
    }
  } catch {
    // ignore
  }
  console.log(`>>> Waiting for bot to start... (${elapsed / 1000}s)`);
}

if (botStarted) {
  console.log('>>> Bot confirmed started (found "starting polling..." in logs)');
} else {
  console.error('>>> WARNING: Bot did not produce "starting polling..." within 60s');
}

nextStep('Verifying container is running');
await ssh('docker ps -a');

nextStep('Bot logs');
await ssh(`docker logs --tail 30 ${CONTAINER}`);

console.log('>>> Done');
