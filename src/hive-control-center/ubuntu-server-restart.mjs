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

// Load configuration from .lenv
const config = makeConfig({
  yargs: ({ yargs, getenv }) =>
    yargs
      .version(false)
      .help(false)
      .option('server-ip', { default: getenv('SERVER_IP') })
      .option('server-user', { default: getenv('SERVER_USER') })
      .option('server-pass', { default: getenv('SERVER_PASS') })
      .option('telegram-bot-token', { default: getenv('TELEGRAM_BOT_TOKEN') })
      .option('telegram-allowed-chats', { default: getenv('TELEGRAM_ALLOWED_CHATS') })
      .option('telegram-hive-overrides', { default: getenv('TELEGRAM_HIVE_OVERRIDES') })
      .option('telegram-solve-overrides', { default: getenv('TELEGRAM_SOLVE_OVERRIDES') })
      .option('telegram-bot-verbose', { default: getenv('TELEGRAM_BOT_VERBOSE') }),
});

const IP = config.serverIp;
const USER = config.serverUser;
const PASS = config.serverPass;

const SSH_OPTS = '-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=10';

// Build BOT_CONFIG in links-notation format for hive-telegram-bot --configuration
const allowedChats = [].concat(config.telegramAllowedChats || []);
const hiveOverrides = [].concat(config.telegramHiveOverrides || []);
const solveOverrides = [].concat(config.telegramSolveOverrides || []);

const BOT_CONFIG = [
  `TELEGRAM_BOT_TOKEN: '${config.telegramBotToken}'`,
  `TELEGRAM_ALLOWED_CHATS:`,
  ...allowedChats.map((c) => `  ${c}`),
  `TELEGRAM_HIVE_OVERRIDES:`,
  ...hiveOverrides.map((o) => `  ${o}`),
  `TELEGRAM_SOLVE_OVERRIDES:`,
  ...solveOverrides.map((o) => `  ${o}`),
  `TELEGRAM_BOT_VERBOSE: ${config.telegramBotVerbose}`,
].join('\n');

// Helper function to sleep
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Helper to run SSH commands and print reproducible command
const ssh = async (command, { silent = false } = {}) => {
  if (!silent) {
    console.log(`>>> sshpass -p '***' ssh ${SSH_OPTS} ${USER}@${IP} ${command}`);
  }
  return await $`sshpass -p ${PASS} ssh ${SSH_OPTS.split(' ')} ${USER}@${IP} ${command}`;
};

// Helper to check SSH availability
const checkSshAvailable = async () => {
  try {
    const result = await $({ mirror: false })`sshpass -p ${PASS} ssh ${SSH_OPTS.split(' ')} ${USER}@${IP} echo up`;
    return result.code === 0;
  } catch {
    return false;
  }
};

// Main execution
await ssh('reboot').catch(() => {
  // Reboot command may close connection abruptly, which is expected
});

console.log('>>> Waiting for server to reboot...');
await sleep(10000);

console.log('>>> Polling SSH availability');
while (!(await checkSshAvailable())) {
  console.log('>>> still down, retrying in 10s');
  await sleep(10000);
}

console.log('>>> Server is back online');

// Write start script to server (base64 encoded to avoid quoting issues)
const startScript = `#!/bin/bash
hive-telegram-bot --configuration "
${BOT_CONFIG}
" 2>&1 | tee -a hive-telegram-bot.log
`;
const base64Script = Buffer.from(startScript).toString('base64');
await ssh(`su - sandbox -c "echo ${base64Script} | base64 -d > ~/start-bot.sh && chmod +x ~/start-bot.sh"`);

// Start bot in screen session (bash -i forces interactive mode to load PATH)
await ssh('su - sandbox -c "bash -i -c \\"screen -S bot -dm ~/start-bot.sh\\""');

// Verify screen is running
await ssh('su - sandbox -c "screen -ls"');

console.log('>>> Done');