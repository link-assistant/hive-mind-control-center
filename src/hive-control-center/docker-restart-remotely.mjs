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
const { makeConfig, LinoEnv } = await use('lino-arguments@0.3.0');

// Load configuration from .lenv (makeConfig for single values + CLI args)
const config = makeConfig({
  yargs: ({ yargs, getenv }) =>
    yargs
      .version(false)
      .help(false)
      .option('server-ip', { default: getenv('SERVER_IP') })
      .option('server-user', { default: getenv('SERVER_USER') })
      .option('server-pass', { default: getenv('SERVER_PASS') })
      .option('telegram-bot-token', { default: getenv('TELEGRAM_BOT_TOKEN') })
      .option('telegram-bot-verbose', { default: getenv('TELEGRAM_BOT_VERBOSE') })
      .option('verbose', { type: 'boolean', default: false, description: 'Enable verbose debug output' })
      .option('dangerously-show-secrets', { type: 'boolean', default: false, description: 'Show secret values in debug output' }),
});

// Read duplicate keys as arrays directly from .lenv (lino-env getAll returns all values for a key)
const lenv = new LinoEnv('.lenv');
lenv.read();
const telegramAllowedChats = lenv.getAll('TELEGRAM_ALLOWED_CHATS') || [];
const telegramHiveOverrides = lenv.getAll('TELEGRAM_HIVE_OVERRIDES') || [];
const telegramSolveOverrides = lenv.getAll('TELEGRAM_SOLVE_OVERRIDES') || [];

const VERBOSE = config.verbose;
const SHOW_SECRETS = config.dangerouslyShowSecrets;

const mask = (value) => SHOW_SECRETS ? value : '***';
const log = (...args) => { if (VERBOSE) console.log('[DEBUG]', ...args); };

log('Loaded config:', {
  serverIp: config.serverIp,
  serverUser: config.serverUser,
  serverPass: mask(config.serverPass),
  telegramBotToken: mask(config.telegramBotToken),
  telegramAllowedChats,
  telegramHiveOverrides,
  telegramSolveOverrides,
  telegramBotVerbose: config.telegramBotVerbose,
});

const IP = config.serverIp;
const USER = config.serverUser;
const PASS = config.serverPass;
const CONTAINER = 'hive-mind';
const IMAGE = 'konard/hive-mind:latest';

// Validate required config
const missing = [];
if (!IP) missing.push('SERVER_IP');
if (!USER) missing.push('SERVER_USER');
if (!PASS) missing.push('SERVER_PASS');
if (!config.telegramBotToken) missing.push('TELEGRAM_BOT_TOKEN');
if (missing.length) {
  console.error(`>>> ERROR: Missing required .lenv values: ${missing.join(', ')}`);
  process.exit(1);
}

const SSH_OPTS = '-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=10 -o LogLevel=ERROR';

// Build BOT_CONFIG in links-notation format for hive-telegram-bot --configuration

const BOT_CONFIG = [
  `TELEGRAM_BOT_TOKEN: '${config.telegramBotToken}'`,
  `TELEGRAM_ALLOWED_CHATS:`,
  ...telegramAllowedChats.map((c) => `  ${c}`),
  `TELEGRAM_HIVE_OVERRIDES:`,
  ...telegramHiveOverrides.map((o) => `  ${o}`),
  `TELEGRAM_SOLVE_OVERRIDES:`,
  ...telegramSolveOverrides.map((o) => `  ${o}`),
  `TELEGRAM_BOT_VERBOSE: ${config.telegramBotVerbose}`,
].join('\n');

log('BOT_CONFIG:\n' + (SHOW_SECRETS ? BOT_CONFIG : BOT_CONFIG.replace(config.telegramBotToken, '***')));

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
const dockerSh = (command, opts) => ssh(`docker exec ${CONTAINER} bash -l -c '${command}'`, opts);

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
    // For auth errors, fail immediately instead of retrying forever
    if (code === 5) {
      console.error('>>> ERROR: Invalid password. Check SERVER_PASS in .lenv');
      process.exit(1);
    }
    if (code === 6) {
      console.error('>>> ERROR: Unknown host key. Check SERVER_IP in .lenv');
      process.exit(1);
    }
    // Connection refused / timeout — server may still be booting, keep retrying
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

nextStep('Checking current container status');
const initialStatus = await getContainerStatus();
console.log(`>>> Container status: ${initialStatus}`);

nextStep('Cleaning up old container and committed image');
await ssh(`docker stop ${CONTAINER} && docker rm ${CONTAINER}`, { ignoreErrors: true });
await ssh(`docker images -q ${CONTAINER}-configured | grep -q . && docker rmi -f ${CONTAINER}-configured || true`, { ignoreErrors: true });

nextStep('Verifying old container is gone');
const afterCleanupStatus = await getContainerStatus();
if (afterCleanupStatus !== 'not_found') {
  console.error(`>>> ERROR: Container still exists after cleanup (status: ${afterCleanupStatus})`);
  process.exit(1);
}
console.log('>>> Old container removed successfully');

nextStep('Pulling latest image');
const pullResult = await ssh(`docker pull ${IMAGE}`);
const pullOutput = pullResult.stdout;

// docker pull prints "Status: Image is up to date for ..." or "Status: Downloaded newer image for ..."
const imageUpToDate = pullOutput.includes('Image is up to date');
const imageDownloaded = pullOutput.includes('Downloaded newer image');

if (imageUpToDate) {
  console.log('>>> Image is already up to date (no download needed)');
} else if (imageDownloaded) {
  console.log('>>> Downloaded newer image');
} else {
  console.log('>>> Image pulled (could not determine if it was updated)');
}

// Show local image details for confirmation
await ssh(`docker images --digests ${IMAGE}`);

// Clean up old/dangling images and reclaim disk space
await ssh(`docker image prune -f`, { ignoreErrors: true });
await ssh(`docker system prune -f`, { ignoreErrors: true });

nextStep('Starting temporary container for setup');
await ssh(`docker run -dit --name ${CONTAINER} ${IMAGE}`);

nextStep('Verifying temporary container is running');
const tempStatus = await getContainerStatus();
if (tempStatus !== 'running') {
  console.error(`>>> ERROR: Temporary container failed to start (status: ${tempStatus})`);
  process.exit(1);
}
console.log('>>> Temporary container is running');

nextStep('Fixing /home/box/.local permissions for box user');
await ssh(`docker exec -u root ${CONTAINER} mkdir -p /home/box/.local/share /home/box/.local/state`);
await ssh(`docker exec -u root ${CONTAINER} chown -R box:box /home/box/.local`);

nextStep('Checking agent --version (first access, before update)');
await dockerSh('agent --version', { ignoreErrors: true });

nextStep('Updating hive-mind, agent, claude-code, and codex');
await dockerSh('bun install -g @link-assistant/hive-mind@latest');
await dockerSh('bun install -g @link-assistant/agent@latest');
await ssh(`docker exec ${CONTAINER} bash -l -c "curl -fsSL https://claude.ai/install.sh | bash"`);
await dockerSh('bun install -g @openai/codex@latest');

nextStep('Checking agent --version (after update)');
await dockerSh('agent --version', { ignoreErrors: true });

nextStep('Initializing Gemini CLI (run three times to create config)');
await dockerSh('gemini --version', { ignoreErrors: true });
await dockerSh('gemini --version', { ignoreErrors: true });
await dockerSh('gemini --version', { ignoreErrors: true });

nextStep('Writing bot start script');
const botStartScript = `#!/bin/bash
source ~/.bashrc
# Append: the log of the run before a crash or restart is evidence for recovery.
while true; do
  echo ">>> Starting hive-telegram-bot..."
  hive-telegram-bot --configuration "
${BOT_CONFIG}
" 2>&1 | tee -a hive-telegram-bot.log
  echo ">>> Bot exited, restarting in 3s..."
  sleep 3
done
`;
log('botStartScript:\n' + (SHOW_SECRETS ? botStartScript : botStartScript.replace(config.telegramBotToken, '***')));
const base64Script = Buffer.from(botStartScript).toString('base64');
log('base64Script length:', base64Script.length);
// Write script on host, copy into container, fix ownership
await ssh(`echo ${base64Script} | base64 -d > /tmp/start-bot.sh`);
await ssh(`docker cp /tmp/start-bot.sh ${CONTAINER}:/home/box/start-bot.sh`);
await ssh(`rm /tmp/start-bot.sh`);
await ssh(`docker exec -u root ${CONTAINER} chown box:box /home/box/start-bot.sh`);

nextStep('Checking agent --version (after configuration)');
await dockerSh('agent --version', { ignoreErrors: true });

nextStep('Committing container');
await ssh(`docker commit ${CONTAINER} ${CONTAINER}-configured`);
await ssh(`docker stop ${CONTAINER}`);
await ssh(`docker rm ${CONTAINER}`);

nextStep('Ensuring host mount directories exist');
await ssh(`mkdir -p /root/.hive-mind/claude /root/.hive-mind/codex /root/.hive-mind/gh`);
await ssh(`touch -a /root/.hive-mind/claude.json`);

nextStep('Starting final container with bot');
// Using -dit so docker attach works with Ctrl+P, Ctrl+Q to detach
// Volume mounts persist claude config, codex config, claude.json, and gh auth across restarts
const MOUNTS = [
  '-v /root/.hive-mind/claude:/home/box/.claude',
  '-v /root/.hive-mind/codex:/home/box/.codex',
  '-v /root/.hive-mind/claude.json:/home/box/.claude.json',
  '-v /root/.hive-mind/gh:/home/box/.config/gh',
].join(' ');
await ssh(`docker run -dit --user box --name ${CONTAINER} --restart unless-stopped ${MOUNTS} ${CONTAINER}-configured bash -l -c 'bash /home/box/start-bot.sh'`);

nextStep('Verifying final container is running');
const finalStatus = await getContainerStatus();
if (finalStatus !== 'running') {
  console.error(`>>> ERROR: Final container failed to start (status: ${finalStatus})`);
  process.exit(1);
}
console.log('>>> Final container is running');

nextStep('Fixing mount permissions');
// Detect the actual UID of the box user from the running container
const idResult = await ssh(`docker exec ${CONTAINER} id -u box`);
const uidGid = idResult.stdout.trim();
log(`Detected UID: ${uidGid}`);
await ssh(`chown -R ${uidGid}:${uidGid} /root/.hive-mind/claude /root/.hive-mind/codex /root/.hive-mind/gh`);
await ssh(`chown ${uidGid}:${uidGid} /root/.hive-mind/claude.json`);

nextStep('Checking agent --version (final container)');
await dockerSh('agent --version');

nextStep('Verifying gh');
try {
  await dockerSh('gh api rate_limit --jq .resources.core');
  console.log('>>> gh is working');
} catch {
  console.error('>>> ERROR: gh verification failed');
  process.exit(1);
}

nextStep('Verifying claude');
try {
  await dockerSh('claude -p hi --model haiku');
  console.log('>>> claude is working');
} catch {
  console.error('>>> ERROR: claude verification failed');
  process.exit(1);
}

nextStep('Verifying codex');
try {
  await dockerSh('codex exec --model gpt-5.4-mini "hi"');
  console.log('>>> codex is working');
} catch {
  console.error('>>> ERROR: codex verification failed');
  process.exit(1);
}

nextStep('Setting up git identity');
await dockerSh('gh-setup-git-identity');

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
  console.error('>>> ERROR: Bot did not produce "starting polling..." within 60s');
  process.exit(1);
}

nextStep('Verifying container is running');
await ssh('docker ps -a');

nextStep('Bot logs');
await ssh(`docker logs --tail 30 ${CONTAINER}`);

console.log('>>> Done');
console.log('>>> To attach to bot output: ssh to server, then: docker attach hive-mind');
console.log('>>> To detach without stopping: Ctrl+P, Ctrl+Q');
