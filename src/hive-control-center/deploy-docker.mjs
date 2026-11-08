#!/usr/bin/env node

// Source of truth (gist, both deploy files):
// https://gist.github.com/konard/67532e7a7090462a618ca86fc00d06a6

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
const fs = await import('node:fs');
const crypto = await import('node:crypto');

const config = makeConfig({
  yargs: ({ yargs, getenv }) =>
    yargs
      .version(false)
      .help(false)
      .option('image-variant', {
        choices: ['dind', 'plain'],
        // Default is 'dind' (konard/hive-mind-dind:1.74.3+ on box-dind 2.1.4+),
        // which gives the bot access to a nested Docker daemon for isolated
        // workloads while keeping docker-exec UX parity with the plain image
        // (link-foundation/box#88 and link-assistant/hive-mind#1850 shipped).
        default: getenv('HIVE_MIND_IMAGE_VARIANT') || 'dind',
        description: 'Image flavor: "dind" (konard/hive-mind-dind, default, needs --privileged) or "plain" (konard/hive-mind)',
      })
      .option('image', {
        type: 'string',
        default: getenv('HIVE_MIND_IMAGE') || '',
        description: 'Override the image reference; takes precedence over --image-variant',
      })
      .option('isolation-mode', {
        choices: ['dood', 'dind'],
        // Only meaningful for the dind image variant (the plain image runs no
        // Docker isolation daemon). Both modes use the SAME image; the mode is
        // chosen by run flags, not by a separate image:
        //   dood (default) - Docker-outside-of-Docker: the bot mounts the HOST
        //     docker socket as its runtime and box's entrypoint skips the nested
        //     dockerd (DIND_SKIP_DAEMON=1). Isolated tasks `docker run` on the
        //     HOST daemon, reusing the host's image with ZERO copy / ZERO extra
        //     disk. Tasks still run in their own container; only the daemon is
        //     shared. This is the only no-copy option on hosts whose free disk
        //     cannot hold a second copy of the multi-GB image.
        //   dind - true Docker-in-Docker: --privileged nested dockerd seeded via
        //     box host-image passthrough (docker save | docker load). Full
        //     per-task daemon isolation, but the passthrough DUPLICATES the
        //     image (~19.5 GB observed) into the nested store.
        default: getenv('HIVE_MIND_ISOLATION_MODE') || 'dood',
        description: 'Docker isolation mode for the dind image: "dood" (default, no-copy, shares host daemon) or "dind" (nested daemon, copies image via passthrough)',
      })
      .option('reset-docker', {
        type: 'boolean',
        default: false,
        description: 'DANGEROUS: remove ALL Docker containers, images, volumes, networks, and build cache on the host before deploying. Use this for a full clean slate.',
      })
      .option('keep-inactive-variant', {
        type: 'boolean',
        default: false,
        description: 'Skip the default behavior of removing the other hive-mind variant\'s image(s). Off by default; the script removes konard/hive-mind* tags that do not match the active variant to reclaim disk.',
      })
      .option('interactive-login', {
        type: 'boolean',
        default: false,
        description: 'When a tool (claude/codex/gh) is NOT authenticated, drop into an INTERACTIVE login inside the container (prints the auth URL, pauses for you to enter the code) instead of just warning. Requires a TTY the whole way (run over `ssh -tt`, which deploy-remote-docker.mjs does). Off by default: without it, an unauthenticated tool is a soft warning and the deploy continues.',
      })
      .option('mtproxy', {
        type: 'boolean',
        // Opt-in: deploy (or update) the Telegram MTProto proxy container next to
        // hive-mind. The default engine is the official classic mtproto-proxy
        // image: it is the only engine that has passed the real end-to-end test
        // on this host (messages + photos + video + large documents). mtg remains
        // available with --mtproxy-engine mtg for experiments, but its FakeTLS
        // ClientHello has repeatedly stalled on this path and is NOT the default.
        default: (getenv('DEPLOY_MTPROXY') || '').toLowerCase() === 'true',
        description: 'Also deploy/update the Telegram MTProto proxy alongside hive-mind. Default engine: classic mtproto-proxy. Configure MTPROXY_PORT/MTPROXY_SECRET in .lenv. Off by default.',
      })
      .option('mtproxy-only', {
        type: 'boolean',
        // SAFE APPEND-ONLY MODE: do ONLY the proxy work (plus the concurrency
        // lock) and exit before any hive-mind step. This never stops/removes/
        // restarts the bot, never prunes containers/images, and never touches a
        // running mtproxy. Use it to add the proxy to an already-deployed box.
        default: (getenv('MTPROXY_ONLY') || '').toLowerCase() === 'true',
        description: 'ONLY install/start the MTProto proxy, then exit. Skips every hive-mind step (no hive-mind pull, restart, or cleanup) and leaves an already-running mtproxy untouched. Implies --mtproxy.',
      })
      .option('mtproxy-update', {
        type: 'boolean',
        // Explicit opt-in to recreate ONLY the proxy container (e.g. to switch
        // images or apply a changed secret). It still never touches hive-mind.
        default: (getenv('MTPROXY_UPDATE') || '').toLowerCase() === 'true',
        description: 'Recreate ONLY the mtproxy container to apply a new image/config. Safe with --mtproxy-only; hive-mind is never touched.',
      })
      .option('mtproxy-engine', {
        choices: ['classic', 'mtg'],
        default: getenv('MTPROXY_ENGINE') || 'classic',
        description: 'Proxy engine: "classic" (official mtproto-proxy; known-good for messages and media) or "mtg" (FakeTLS experiment). Default classic.',
      })
      .option('verify-mtproxy', {
        type: 'boolean',
        default: (getenv('VERIFY_MTPROXY') || '').toLowerCase() === 'true',
        description: 'After deploying/leaving mtproxy, verify the selected engine (classic: port, MSS clamp, Telegram DC reachability; mtg: mtg doctor). Fails on critical checks.',
      })
      .option('mtproxy-image', {
        type: 'string',
        default: getenv('MTPROXY_IMAGE') || '',
        description: 'mtg-compatible image override (only used with --mtproxy-engine mtg; default nineseconds/mtg:2.3.0)',
      })
      .option('mtproxy-classic-image', {
        type: 'string',
        default: getenv('MTPROXY_CLASSIC_IMAGE') || 'mtproxy/mtproxy:latest',
        description: 'Classic engine image (default mtproxy/mtproxy:latest; must read SECRET from /data/secret or env)',
      })
      .option('mtproxy-port', {
        type: 'string',
        default: getenv('MTPROXY_PORT') || '443',
        description: 'Host port to publish the MTProto proxy on (default 443; container always listens on 443)',
      })
      .option('mtproxy-mss', {
        type: 'string',
        default: getenv('MTPROXY_MSS') || '1200',
        description: 'TCP MSS clamp for the proxy host port(s), both directions (default 1200; 1360 was too high on the mobile path)',
      })
      .option('mtproxy-fronting-host', {
        type: 'string',
        default: getenv('MTPROXY_FRONTING_HOST') || 'contabo.com',
        description: 'Hostname embedded in the mtg FakeTLS secret and used as the domain-fronting backend (default contabo.com)',
      })
      .option('mtproxy-secret', {
        type: 'string',
        default: getenv('MTPROXY_SECRET') || '',
        description: 'Optional 32-char hex key (classic) or mtg FakeTLS secret (ee... hex). Empty reuses the persisted key, or generates one.',
      })
      .option('server-ip', {
        type: 'string',
        default: getenv('SERVER_IP') || '',
        description: 'Public IPv4 to advertise in the mtg config/link (default SERVER_IP from .lenv)',
      })
      .option('verbose', { type: 'boolean', default: false, description: 'Enable verbose debug output' })
      .option('dangerously-show-secrets', { type: 'boolean', default: false, description: 'Show secret values in debug output' }),
});

const VERBOSE = config.verbose;
const SHOW_SECRETS = config.dangerouslyShowSecrets;

const log = (...args) => { if (VERBOSE) console.log('[DEBUG]', ...args); };

const CONTAINER = 'hive-mind';

// Optional Telegram MTProto proxy deployed alongside the bot (--mtproxy).
//
// The DEFAULT engine is the official classic mtproto-proxy image. It is the only
// configuration that survived a real end-to-end test on this host: messages,
// photos, videos and multi-MB documents. `nineseconds/mtg` remains selectable with
// --mtproxy-engine mtg for experiments, but its FakeTLS ClientHello repeatedly
// stalled on the mobile path, so it must never be the default again.
//
// Secrets are persisted root-only and never printed by default. The classic
// container name includes the host port (`mtproxy-classic-443`), which lets a
// second instance run on e.g. 8443 without racing the production one.
const MTPROXY_ENGINE = String(config.mtproxyEngine || 'classic').toLowerCase();
const MTPROXY_HOST_PORT = String(config.mtproxyPort || '443').trim();
const MTPROXY_CONTAINER_PORT = '443';
const MTPROXY_MTG_CONFIG_DIR = '/root/.hive-mtproxy';
const MTPROXY_CLASSIC_CONFIG_DIR = `/root/.hive-mtproxy-classic-${MTPROXY_HOST_PORT}`;
const MTPROXY_CONTAINER = MTPROXY_ENGINE === 'classic'
  ? `mtproxy-classic-${MTPROXY_HOST_PORT}`
  : 'mtproxy';
const MTPROXY_CONFIG_DIR = MTPROXY_ENGINE === 'classic'
  ? MTPROXY_CLASSIC_CONFIG_DIR
  : MTPROXY_MTG_CONFIG_DIR;
const MTPROXY_CONFIG_PATH = `${MTPROXY_CONFIG_DIR}/config.toml`;
const MTPROXY_CLASSIC_SECRET_PATH = `${MTPROXY_CLASSIC_CONFIG_DIR}/secret`;
const MTPROXY_LINK_PATH = `${MTPROXY_CONFIG_DIR}/link.txt`;
const MTPROXY_DEFAULT_IMAGE = 'nineseconds/mtg:2.3.0';
const MTPROXY_CLASSIC_DEFAULT_IMAGE = 'mtproxy/mtproxy:latest';
const MTPROXY_CLASSIC_IMAGE = String(config.mtproxyClassicImage || MTPROXY_CLASSIC_DEFAULT_IMAGE).trim();
const MTPROXY_MTG_IMAGE = String(config.mtproxyImage || MTPROXY_DEFAULT_IMAGE).trim();
const MTPROXY_MSS = String(config.mtproxyMss || '1200').trim();
const MTPROXY_ACTIVE_IMAGE = MTPROXY_ENGINE === 'classic' ? MTPROXY_CLASSIC_IMAGE : MTPROXY_MTG_IMAGE;
// --mtproxy-only is the safe append-only entry point: it implies --mtproxy but
// exits right after the proxy work, before ANY hive-mind teardown/restart.
const MTPROXY_ONLY = config.mtproxyOnly === true;
if (MTPROXY_ONLY) config.mtproxy = true;

// Per-variant settings. Both images default USER to box and run user-level
// tools out of /home/box. The dind image additionally runs an inner dockerd
// (launched by /usr/local/bin/dind-entrypoint.sh via scoped NOPASSWD sudo)
// and so needs --privileged on `docker run`.
// Per-variant settings declare what is fixed by the IMAGE (repo, user, entrypoint).
// The dind image additionally supports two Docker-isolation MODES, chosen at run
// time (see MODE_FLAGS below), NOT by a separate image:
//
//   dood (default) - Docker-outside-of-Docker. The bot mounts the HOST docker
//     socket as its runtime and box's entrypoint skips the nested dockerd
//     (DIND_SKIP_DAEMON=1). Isolated tasks `docker run` on the HOST daemon, which
//     already has the konard/hive-mind-dind image, so it is reused with ZERO copy,
//     ZERO load, ZERO extra disk. Each task still runs in its own container;
//     only the daemon is shared. The only no-copy option on disk-constrained hosts.
//
//   dind - true Docker-in-Docker. --privileged nested dockerd, seeded from the
//     host via box host-image passthrough (docker save | docker load). Full
//     per-task daemon isolation, but passthrough DUPLICATES the image (~19.5 GB
//     observed) into the nested store and re-copies unless persisted.
//
// See link-assistant/hive-mind#1914 / #1946 and link-foundation/box (no zero-copy
// share-mode for nested passthrough; the dind image supports DooD out of the box).
const VARIANTS = {
  dind: {
    image: 'konard/hive-mind-dind:latest',
    // No --user override: image defaults to box (hive-mind 1.74.3 / box-dind 2.1.4).
    finalUserFlag: '',
    // execUserFlag is empty because the image defaults to USER=box, so plain
    // `docker exec hive-mind ...` already runs as box.
    execUserFlag: '',
    // Belt-and-suspenders: docker commit preserves ENTRYPOINT from the parent
    // image, but pinning it defends against future commit-semantics surprises.
    entrypointFlag: '--entrypoint /usr/local/bin/dind-entrypoint.sh',
    // The dind image supports Docker isolation modes (dood / dind).
    supportsIsolationModes: true,
  },
  plain: {
    image: 'konard/hive-mind:latest',
    finalUserFlag: '--user box',
    execUserFlag: '',
    entrypointFlag: '',
    // The plain image runs no Docker isolation daemon at all.
    supportsIsolationModes: false,
  },
};

const VARIANT = VARIANTS[config.imageVariant];
const IMAGE = config.image || VARIANT.image;

// Resolve the effective isolation MODE. Only the dind image supports modes; for
// the plain image the flag is inert and there is no isolation daemon.
const MODE = VARIANT.supportsIsolationModes ? config.isolationMode : 'none';

// Mode-specific run-time settings. These were previously baked into the variant;
// keeping them mode-driven lets one image serve both DooD and DinD.
//   runFlags      - extra `docker run` flags for the FINAL bot container
//   tempEnvFlags  - env for the setup container (never starts a nested daemon)
//   finalEnvFlags - env for the final container
//   needsDockerd  - true => wait for a nested dockerd + verify passthrough seed
//   isDooD        - true => bot shares host daemon; ensure host has the image
const MODE_FLAGS = {
  dood: {
    // Mount the HOST socket as the REAL runtime (/var/run/docker.sock). box's
    // entrypoint runs fix_socket_permissions; we also --group-add at runtime.
    runFlags: '-v /var/run/docker.sock:/var/run/docker.sock',
    tempEnvFlags: '-e DIND_SKIP_DAEMON=1',
    finalEnvFlags: '-e DIND_SKIP_DAEMON=1',
    needsDockerd: false,
    isDooD: true,
  },
  dind: {
    // --privileged so the entrypoint can start the nested dockerd. The host
    // socket is mounted at the NON-default host-docker.sock path (seed only).
    // Concrete-tag passthrough allowlist is appended at runtime (CHILD_IMAGE).
    runFlags: '--privileged -v /var/run/docker.sock:/var/run/host-docker.sock:ro',
    tempEnvFlags: '-e DIND_SKIP_DAEMON=1',
    finalEnvFlags: '-e DIND_SKIP_DAEMON=0 -e DIND_WAIT_SECONDS=180',
    needsDockerd: true,
    isDooD: false,
  },
  // plain image: no isolation daemon, no special run flags.
  none: {
    runFlags: '',
    tempEnvFlags: '',
    finalEnvFlags: '',
    needsDockerd: false,
    isDooD: false,
  },
};
const MODEF = MODE_FLAGS[MODE];

console.log(`>>> Image variant: ${config.imageVariant} (image: ${IMAGE})`);
if (VARIANT.supportsIsolationModes) {
  console.log(`>>> Docker isolation mode: ${MODE}${MODE === 'dood' ? ' (no-copy, shares host daemon)' : ' (nested daemon, passthrough copy)'}`);
}

// Repository names (without tag) for each variant, used for inactive-variant
// cleanup so all tags of the *other* variant get removed when we switch.
const stripTag = (ref) => ref.replace(/:[^/:]+$/, '');
const getTag = (ref) => {
  const match = ref.match(/:([^/:]+)$/);
  return match ? match[1] : 'latest';
};
const ACTIVE_REPO = stripTag(IMAGE);
const ACTIVE_TAG = getTag(IMAGE);
const INACTIVE_REPOS = Object.entries(VARIANTS)
  .filter(([name]) => name !== config.imageVariant)
  .map(([, v]) => stripTag(v.image))
  .filter((repo) => repo !== ACTIVE_REPO);

// Workaround: lino-env does not support multi-line quoted values (" or ').
// Until https://github.com/link-foundation/lino-env supports multi-line
// quoted strings (see links-notation MultilineQuotedString.test.js), we
// parse HIVE_TELEGRAM_BOT_CONFIGURATION directly from .lenv.
const readMultilineQuoted = (filePath, key) => {
  const text = fs.readFileSync(filePath, 'utf8');
  const re = new RegExp(`^${key}:\\s*(["'])([\\s\\S]*?)\\1`, 'm');
  const m = text.match(re);
  return m ? m[2] : null;
};

const BOT_CONFIG = readMultilineQuoted('.lenv', 'HIVE_TELEGRAM_BOT_CONFIGURATION');

if (!BOT_CONFIG) {
  console.error('>>> ERROR: Missing required .lenv value: HIVE_TELEGRAM_BOT_CONFIGURATION');
  process.exit(1);
}

// Read a top-level scalar `.lenv` key (LINO `KEY: value` on one line). Used to
// forward bot runtime env (e.g. HIVE_MIND_DISK_THRESHOLD) into the start script.
const readLenvScalar = (filePath, key) => {
  const text = fs.readFileSync(filePath, 'utf8');
  const re = new RegExp(`^${key}:[ \\t]*(.+?)[ \\t]*$`, 'm');
  const m = text.match(re);
  return m ? m[1].trim() : null;
};

// Bot runtime env vars sourced from top-level .lenv keys. Each is exported in the
// bot start script so hive-telegram-bot reads them from process.env. Keys absent
// from .lenv are silently skipped (see the .filter below), so an unset key just
// falls back to the hive-mind default. HIVE_MIND_MIN_START_INTERVAL_MS is the
// "interval between tasks" (min gap between starting successive tasks, ms). The
// disk threshold is the queue admission gate (float ratio 0.0-1.0); lowering it
// makes the bot stop launching tasks before the host fills up.
//
// HIVE_MIND_MIN_START_INTERVAL_FLOOR_MS must be forwarded alongside any
// MIN_START_INTERVAL_MS below 10 min: hive-mind resolves the interval as
// Math.max(MIN_START_INTERVAL_MS, FLOOR_MS) and FLOOR_MS still defaults to
// 10 min, so a lower interval alone is silently clamped back up to 10 min
// (hive-mind#2053). Setting both is the supported way to go under 10 min.
const BOT_ENV_KEYS = ['HIVE_MIND_MIN_START_INTERVAL_MS', 'HIVE_MIND_MIN_START_INTERVAL_FLOOR_MS', 'HIVE_MIND_DISK_THRESHOLD', 'HIVE_MIND_MIN_DISK_SPACE_MB'];
const botEnvExports = BOT_ENV_KEYS
  .map((key) => [key, readLenvScalar('.lenv', key)])
  .filter(([, value]) => value !== null)
  .map(([key, value]) => `export ${key}=${value}`)
  .join('\n');
if (botEnvExports) {
  console.log(`>>> Forwarding .lenv bot env to start script:\n${botEnvExports}`);
}
const tokenMatch = BOT_CONFIG.match(/TELEGRAM_BOT_TOKEN:\s*'([^']+)'/);
const telegramBotToken = tokenMatch ? tokenMatch[1] : null;

const redact = (str) => (SHOW_SECRETS || !telegramBotToken) ? str : str.replaceAll(telegramBotToken, '***');

log('BOT_CONFIG:\n' + redact(BOT_CONFIG));

// Helper function to sleep
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Run a command without mirroring its stdout/stderr. Use this for output that
// may contain credentials (mtg access) or that we print ourselves (mtg doctor).
const capture = async (command) => {
  try {
    const result = await $({ mirror: false })`bash -c ${command}`;
    return {
      code: result.code ?? 0,
      stdout: String(result.stdout || ''),
      stderr: String(result.stderr || ''),
    };
  } catch (error) {
    return {
      code: error.code ?? 1,
      stdout: String(error.stdout || ''),
      stderr: String(error.stderr || ''),
    };
  }
};

// Helper to run local shell commands and print them
const run = async (command, { silent = false, ignoreErrors = false } = {}) => {
  if (!silent) {
    console.log(`>>> ${command}`);
  }
  try {
    const result = await $`bash -c ${command}`;
    log(`Exit code: ${result.code}`);
    return result;
  } catch (error) {
    log(`Command failed (code ${error.code}):`, error.message || error);
    if (!ignoreErrors) throw error;
  }
};

// Helper to run a command inside the container as the box user via bash.
// Both variants default USER to box (since hive-mind 1.74.3 / box-dind 2.1.4),
// so execUserFlag is empty for both. Kept variant-driven in case a future
// image variant needs an explicit -u override again. The .replace collapses
// the double space we'd otherwise emit when execUserFlag is empty.
const dockerSh = (command, opts) => run(
  `docker exec ${VARIANT.execUserFlag} ${CONTAINER} bash -l -c '${command}'`.replace(/  +/g, ' '),
  opts
);

// ── Interactive login (opt-in via --interactive-login) ───────────────────────
// Run a login command INSIDE the container with a FULL interactive TTY so the
// operator can complete a browser/device-code auth flow (paste a code, press a
// key). This only works when there is a real TTY the whole way up the chain:
//   local terminal -> command-stream $({interactive}) -> ssh -tt -> here ->
//   docker exec -it -> the CLI's login prompt.
// deploy-remote-docker.mjs runs THIS script over `ssh -tt`, and command-stream's
// `interactive: true` (with stdin:'inherit') forwards stdio to the child, so the
// keystrokes reach the container. If any link lacks a TTY (e.g. run non-tty),
// the CLI simply can't prompt — we detect that and tell the operator to log in
// manually. This code path is NOT exercised in the default deploy; it is here so
// `--interactive-login` has a tested-shape implementation to grow from.
//
// NOTE: intentionally UNVERIFIED end-to-end (no time to test the nested TTY
// passthrough live). It is gated behind --interactive-login precisely so the
// default deploy never depends on it.
const interactiveLogin = async (label, loginCommand) => {
  console.log(`>>> ── Interactive login: ${label} ──`);
  console.log('>>>    A prompt/URL should appear below. Follow it (open the URL, paste the code),');
  console.log('>>>    then return here. The deploy resumes once the login command exits.');
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.log(`>>> WARNING: no TTY attached — cannot run an interactive ${label} login here.`);
    console.log(`>>>          Re-run over \`ssh -tt\` (deploy-remote-docker.mjs does this) with --interactive-login,`);
    console.log(`>>>          or log in manually: docker exec -it ${CONTAINER} bash -lc '${loginCommand}'`);
    return false;
  }
  // interactive:true + stdin:'inherit' => command-stream forwards our TTY to the
  // child; `docker exec -it` allocates a pty inside the container.
  const $i = $({ interactive: true, stdin: 'inherit', mirror: true, capture: false });
  const full = `docker exec -it ${VARIANT.execUserFlag} ${CONTAINER} bash -l -c '${loginCommand}'`.replace(/  +/g, ' ');
  try {
    await $i`${full}`;
    console.log(`>>> ${label} interactive login finished.`);
    return true;
  } catch (e) {
    console.log(`>>> WARNING: ${label} interactive login exited with an error (${e?.code ?? '?'}); continuing. Log in manually if needed.`);
    return false;
  }
};

// One place that decides, for an unauthenticated tool, whether to attempt an
// interactive login (opt-in) or just warn and continue (default). NEVER exits —
// an unauthenticated tool must not fail the deploy.
const handleUnauthenticated = async (label, loginCommand, detail) => {
  console.log(`>>> WARNING: ${label} is not authenticated — the bot needs a manual login for it to work.`);
  if (detail) console.log(`>>> ${detail}`);
  if (config.interactiveLogin) {
    await interactiveLogin(label, loginCommand);
  } else {
    console.log(`>>>          To log in: docker exec -it ${CONTAINER} bash -lc '${loginCommand}'`);
    console.log('>>>          (or re-run the deploy with --interactive-login to be prompted automatically).');
  }
};

// Helper to get container status
const getContainerStatus = async (name = CONTAINER) => {
  try {
    const result = await $({ mirror: false })`docker inspect -f {{.State.Status}} ${name}`;
    return result.stdout.trim() || 'not_found';
  } catch {
    return 'not_found';
  }
};

// ── Optional Telegram MTProto proxy (--mtproxy) ──────────────────────────────
// Deploy `nineseconds/mtg`, a maintained FakeTLS MTProto proxy, so clients can
// reach Telegram over networks where plain MTProto is blocked. The container:
//   • publishes MTPROXY_PORT (default 443) on the host to port 443 in-container;
//   • reads a root-only config from /root/.hive-mtproxy/config.toml; the FakeTLS
//     secret is persisted there, so redeploys keep the same connection link;
//   • uses `--restart unless-stopped`, so it survives host reboots like the bot.
//
// A custom secret can be pinned with MTPROXY_SECRET in .lenv. The secret/link is
// deliberately NOT printed by default (it is a credential); the tg:// and t.me
// links are written to /root/.hive-mtproxy/link.txt (mode 0600). Use
// --dangerously-show-secrets to also echo them, or `--verify-mtproxy` to run
// mtg's own doctor checks.
const detectMtproxyPublicIpv4 = async () => {
  const configured = String(config.serverIp || '').trim();
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(configured)) return configured;
  try {
    const result = await $({ mirror: false })`curl -4 -sS --max-time 8 https://api.ipify.org`;
    const ip = (result.stdout || '').trim();
    if (result.code === 0 && /^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return ip;
  } catch { /* fall through */ }
  return '';
};

const detectMtproxyPublicIpv6 = async () => {
  try {
    const result = await $({ mirror: false })`ip -6 addr show scope global`;
    const match = (result.stdout || '').match(/\binet6\s+([0-9a-f:]+)\//i);
    return match ? match[1] : '';
  } catch {
    return '';
  }
};

const readPersistedMtproxySecret = () => {
  try {
    const text = fs.readFileSync(MTPROXY_CONFIG_PATH, 'utf8');
    return (text.match(/^\s*secret\s*=\s*"([^"]+)"/m) || [])[1] || '';
  } catch {
    return '';
  }
};

const mtproxySecretHost = (secret) => {
  if (!/^ee[0-9a-f]{32}[0-9a-f]+$/i.test(secret)) return '';
  try {
    return Buffer.from(secret.slice(34), 'hex').toString('utf8');
  } catch {
    return '';
  }
};

const buildMtproxySecret = (frontingHost) => {
  const configured = String(config.mtproxySecret || '').trim();
  if (configured) {
    if (/^ee[0-9a-f]{32}[0-9a-f]+$/i.test(configured)) return configured.toLowerCase();
    if (/^[0-9a-f]{32}$/i.test(configured)) {
      // Backward compatibility: treat a legacy 32-char key as the FakeTLS key
      // and append the fronting hostname, producing a valid mtg secret.
      return `ee${configured.toLowerCase()}${Buffer.from(frontingHost).toString('hex')}`;
    }
    console.error('>>> ERROR: MTPROXY_SECRET must be an mtg FakeTLS secret (ee... hex) or a legacy 32-char hex key.');
    console.error('>>>        Leave MTPROXY_SECRET unset to generate and persist a FakeTLS secret automatically.');
    process.exit(1);
  }
  const persisted = readPersistedMtproxySecret();
  if (persisted) {
    const persistedHost = mtproxySecretHost(persisted);
    if (persistedHost && persistedHost !== frontingHost) {
      console.log(`>>>   Fronting host changed (${persistedHost} -> ${frontingHost}); generating a new FakeTLS secret (the link will change).`);
      return `ee${crypto.randomBytes(16).toString('hex')}${Buffer.from(frontingHost).toString('hex')}`;
    }
    return persisted;
  }
  return `ee${crypto.randomBytes(16).toString('hex')}${Buffer.from(frontingHost).toString('hex')}`;
};

const saveMtproxyLink = async () => {
  const access = await capture(`docker exec ${MTPROXY_CONTAINER} /mtg access /config.toml`);
  if (access.code !== 0) {
    console.log('>>> WARNING: Could not read the mtg access links yet.');
    return;
  }
  try {
    const data = JSON.parse(access.stdout);
    const links = [];
    for (const key of ['ipv4', 'ipv6']) {
      if (data[key]?.tg_url) links.push(data[key].tg_url);
      if (data[key]?.tme_url) links.push(data[key].tme_url);
    }
    const unique = [...new Set(links)];
    if (!unique.length) return;
    fs.writeFileSync(MTPROXY_LINK_PATH, `${unique.join('\n')}\n`, { mode: 0o600 });
    fs.chmodSync(MTPROXY_LINK_PATH, 0o600);
    console.log(`>>>   Connection link saved to ${MTPROXY_LINK_PATH} (root-only).`);
    if (SHOW_SECRETS) {
      for (const link of unique) console.log(`>>>   ${link}`);
    } else {
      console.log(`>>>   Read it with: cat ${MTPROXY_LINK_PATH}`);
    }
  } catch {
    console.log('>>> WARNING: mtg access output was not valid JSON; no link saved.');
  }
};

const verifyMtproxy = async () => {
  console.log('>>> Verifying MTProxy with mtg doctor ...');
  const doctor = await capture(`docker exec ${MTPROXY_CONTAINER} /mtg doctor /config.toml`);
  const output = `${doctor.stdout}\n${doctor.stderr}`.trim();
  if (output) {
    for (const line of output.split('\n')) console.log(`>>>   ${line}`);
  }
  if (!output.includes('Validate native network connectivity')) {
    console.error('>>> ERROR: mtg doctor did not complete; MTProxy verification failed.');
    await run(`docker logs --tail 80 ${MTPROXY_CONTAINER}`, { ignoreErrors: true });
    process.exit(1);
  }
  // The SNI-DNS match check is expected to warn for domain-fronting setups and is
  // reported above but tolerated. Failures in the core reachability/fronting-TLS
  // sections are fatal.
  const criticalSections = new Set([
    'Validate native network connectivity',
    'Validate fronting domain connectivity',
  ]);
  let section = '';
  const failures = [];
  for (const raw of output.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    // Section headers are unindented; check lines are indented under them.
    // Do not rely on the header text alone: names like "Validate SNI-DNS match"
    // contain a hyphen and would otherwise be mistaken for a check line.
    if (!/^\s/.test(raw) && !line.startsWith('✅') && !line.startsWith('❌')) {
      section = line;
      continue;
    }
    if (line.includes('❌') && criticalSections.has(section)) failures.push(line);
  }
  if (failures.length) {
    console.error('>>> ERROR: mtg doctor reports critical connectivity failures:');
    for (const line of failures) console.error(`>>>        ${line}`);
    process.exit(1);
  }
  console.log(doctor.code === 0
    ? '>>> ✅ MTProxy verification passed (mtg doctor).'
    : '>>> ✅ MTProxy core connectivity verified; the expected domain-fronting SNI-DNS mismatch warning is tolerated.');
};


// ── Classic engine (official mtproto-proxy) ────────────────────────────────
// This is the known-good path. The image auto-downloads Telegram's current
// getProxyConfig/getProxySecret at startup, so the DC map (including media DCs)
// stays fresh. The 2019 engine is old but it is the one that actually completed
// messages, photos and multi-MB media on this host; mtg did not.
const normalizeClassicSecret = (value) => {
  const raw = String(value || '').trim();
  if (/^[0-9a-f]{32}$/i.test(raw)) return raw.toLowerCase();
  // Accept an mtg FakeTLS secret for migration: ee<32-hex-key><host-hex>.
  if (/^ee[0-9a-f]{32}/i.test(raw)) return raw.slice(2, 34).toLowerCase();
  return '';
};

const readPersistedClassicSecret = () => {
  try {
    return normalizeClassicSecret(fs.readFileSync(MTPROXY_CLASSIC_SECRET_PATH, 'utf8'));
  } catch {
    return '';
  }
};

const buildClassicSecret = () => {
  const configured = String(config.mtproxySecret || '').trim();
  if (configured) {
    const normalized = normalizeClassicSecret(configured);
    if (!normalized) {
      console.error('>>> ERROR: MTPROXY_SECRET must be a 32-char hex key or an mtg ee... secret for the classic engine.');
      console.error('>>>        Leave it unset to reuse the persisted key, or to generate a new one.');
      process.exit(1);
    }
    return normalized;
  }
  const persisted = readPersistedClassicSecret();
  if (persisted) return persisted;
  return crypto.randomBytes(16).toString('hex');
};

const installClassicMss = async () => {
  const mss = MTPROXY_MSS;
  if (!/^\d+$/.test(mss) || Number(mss) < 536 || Number(mss) > 1460) {
    console.error(`>>> ERROR: Invalid MTPROXY_MSS "${mss}" (expected 536-1460).`);
    process.exit(1);
  }
  const ports = [...new Set([MTPROXY_HOST_PORT, '443', '8443'])].filter((p) => /^\d+$/.test(p)).join(' ');
  const script = `#!/bin/sh
set -eu

add_rule() {
  iptables -t mangle -C "$@" 2>/dev/null || iptables -t mangle -A "$@"
}

for port in ${ports}; do
  add_rule FORWARD -p tcp --sport "$port" --tcp-flags SYN,RST SYN -j TCPMSS --set-mss ${mss}
  add_rule FORWARD -p tcp --dport "$port" --tcp-flags SYN,RST SYN -j TCPMSS --set-mss ${mss}
done
`;
  const unit = `[Unit]
Description=Clamp TCP MSS for MTProto proxy traffic (Docker bridge PMTU)
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/mtproxy-mss.sh
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
`;
  const scriptB64 = Buffer.from(script).toString('base64');
  const unitB64 = Buffer.from(unit).toString('base64');
  await run(`echo ${scriptB64} | base64 -d > /usr/local/sbin/mtproxy-mss.sh && chmod 755 /usr/local/sbin/mtproxy-mss.sh`, { silent: true });
  await run(`echo ${unitB64} | base64 -d > /etc/systemd/system/mtproxy-mss.service && chmod 644 /etc/systemd/system/mtproxy-mss.service`, { silent: true });
  await run('systemctl daemon-reload && systemctl enable mtproxy-mss.service && systemctl restart mtproxy-mss.service', { silent: true });
  console.log(`>>>   MSS clamp installed for ports ${ports} at ${mss}, both directions (mtproxy-mss.service)`);
};

const verifyClassicMss = async () => {
  const mss = MTPROXY_MSS;
  const ports = [...new Set([MTPROXY_HOST_PORT, '443', '8443'])].filter((p) => /^\d+$/.test(p));
  const enabled = (await capture('systemctl is-enabled mtproxy-mss.service 2>/dev/null')).stdout.trim();
  const active = (await capture('systemctl is-active mtproxy-mss.service 2>/dev/null')).stdout.trim();
  const rules = (await capture('iptables -t mangle -S FORWARD 2>/dev/null || true')).stdout;
  const missing = [];
  if (enabled !== 'enabled') missing.push('mtproxy-mss.service is not enabled');
  if (active !== 'active') missing.push('mtproxy-mss.service is not active');
  for (const port of ports) {
    for (const dir of ['sport', 'dport']) {
      const needle = `--${dir} ${port} --tcp-flags SYN,RST SYN -j TCPMSS --set-mss ${mss}`;
      if (!new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).test(rules)) {
        missing.push(`missing MSS rule: --${dir} ${port} -> ${mss}`);
      }
    }
  }
  if (missing.length) {
    console.error('>>> ERROR: classic MTProxy TCP MSS protection is incomplete:');
    for (const item of missing) console.error(`>>>        ${item}`);
    console.error('>>>        Re-run with --mtproxy-update to repair it.');
    process.exit(1);
  }
  console.log(`>>>   MSS ${mss} present for ${ports.map((p) => `:${p}`).join(', ')} (both directions)`);
};

const saveClassicLink = (secret, publicIpv4) => {
  if (!publicIpv4) return;
  const link = `tg://proxy?server=${publicIpv4}&port=${MTPROXY_HOST_PORT}&secret=dd${secret}`;
  fs.writeFileSync(MTPROXY_LINK_PATH, `${link}\n`, { mode: 0o600 });
  fs.chmodSync(MTPROXY_LINK_PATH, 0o600);
  console.log(`>>>   Connection link saved to ${MTPROXY_LINK_PATH} (root-only).`);
  if (SHOW_SECRETS) console.log(`>>>   ${link}`);
  else console.log(`>>>   Read it with: cat ${MTPROXY_LINK_PATH}`);
};

const verifyClassicMtproxy = async () => {
  console.log('>>> Verifying classic MTProxy ...');
  const status = await getContainerStatus(MTPROXY_CONTAINER);
  if (status !== 'running') {
    console.error(`>>> ERROR: ${MTPROXY_CONTAINER} is not running (status: ${status}).`);
    await run(`docker logs --tail 80 ${MTPROXY_CONTAINER}`, { ignoreErrors: true });
    process.exit(1);
  }
  const policy = (await capture(`docker inspect -f '{{.HostConfig.RestartPolicy.Name}}' ${MTPROXY_CONTAINER}`)).stdout.trim();
  if (policy !== 'unless-stopped') {
    console.error(`>>> ERROR: ${MTPROXY_CONTAINER} restart policy is "${policy}", expected unless-stopped.`);
    process.exit(1);
  }
  const logs = `${(await capture(`docker logs --tail 120 ${MTPROXY_CONTAINER} 2>&1`)).stdout}`;
  if (/\[F\]|Cannot download|Bad secret format/i.test(logs)) {
    console.error('>>> ERROR: classic MTProxy logs contain a fatal startup error.');
    await run(`docker logs --tail 80 ${MTPROXY_CONTAINER}`, { ignoreErrors: true });
    process.exit(1);
  }
  const listening = (await capture(`ss -ltnH '( sport = :${MTPROXY_HOST_PORT} )' 2>/dev/null || ss -ltn 2>/dev/null`)).stdout;
  if (!new RegExp(`[:.]${MTPROXY_HOST_PORT}\\s`).test(listening)) {
    console.error(`>>> ERROR: nothing is listening on host port ${MTPROXY_HOST_PORT}.`);
    process.exit(1);
  }
  await verifyClassicMss();
  const targets = ['149.154.161.144:8888', '149.154.161.184:8888', '91.105.192.110:443'];
  for (const target of targets) {
    const [ip, port] = target.split(':');
    const probe = await capture(`timeout 5 bash -c '</dev/tcp/${ip}/${port}'`);
    if (probe.code !== 0) {
      console.error(`>>> ERROR: server cannot reach Telegram DC ${target}.`);
      process.exit(1);
    }
  }
  console.log(`>>> ✅ Classic MTProxy verification passed (${MTPROXY_CONTAINER}, :${MTPROXY_HOST_PORT}, MSS ${MTPROXY_MSS}).`);
};

const deployMtproxyClassic = async ({ appendOnly = false, forceUpdate = false } = {}) => {
  const update = forceUpdate || config.mtproxyUpdate === true;

  if (appendOnly && !update) {
    const current = await getContainerStatus(MTPROXY_CONTAINER);
    if (current === 'running') {
      console.log(`>>> MTProxy "${MTPROXY_CONTAINER}" is already running — leaving it and hive-mind untouched.`);
      console.log(`>>>   Connection link: cat ${MTPROXY_LINK_PATH}`);
      if (config.verifyMtproxy) await verifyClassicMtproxy();
      return;
    }
    if (current !== 'not_found') {
      console.log(`>>> MTProxy "${MTPROXY_CONTAINER}" exists but is ${current}; starting it without recreating.`);
      const started = await run(`docker start ${MTPROXY_CONTAINER}`, { silent: true, ignoreErrors: true });
      let startedStatus = await getContainerStatus(MTPROXY_CONTAINER);
      for (let attempt = 0; attempt < 8 && started?.code === 0 && startedStatus !== 'running'; attempt++) {
        await sleep(2000);
        startedStatus = await getContainerStatus(MTPROXY_CONTAINER);
      }
      if (started?.code === 0 && startedStatus === 'running') {
        console.log(`>>> MTProxy "${MTPROXY_CONTAINER}" is running again (same container and config).`);
        if (config.verifyMtproxy) await verifyClassicMtproxy();
        return;
      }
      console.error(`>>> ERROR: Could not start the existing MTProxy container (status: ${startedStatus}).`);
      console.error('>>>        It was NOT removed or recreated — fix the cause (e.g. port in use) and retry.');
      await run(`docker logs --tail 80 ${MTPROXY_CONTAINER}`, { ignoreErrors: true });
      process.exit(1);
    }
  }

  if (!/^\d+$/.test(MTPROXY_HOST_PORT) || Number(MTPROXY_HOST_PORT) < 1 || Number(MTPROXY_HOST_PORT) > 65535) {
    console.error(`>>> ERROR: Invalid MTPROXY_PORT "${MTPROXY_HOST_PORT}" (expected 1-65535).`);
    process.exit(1);
  }
  if (/mtg/i.test(MTPROXY_CLASSIC_IMAGE)) {
    console.error(`>>> ERROR: --mtproxy-classic-image "${MTPROXY_CLASSIC_IMAGE}" looks like mtg; use --mtproxy-engine mtg instead.`);
    process.exit(1);
  }

  const secret = buildClassicSecret();
  const publicIpv4 = await detectMtproxyPublicIpv4();
  if (!publicIpv4) {
    console.log('>>> WARNING: Could not determine the public IPv4; the generated link may be wrong until SERVER_IP is set.');
  }

  fs.mkdirSync(MTPROXY_CLASSIC_CONFIG_DIR, { recursive: true, mode: 0o700 });
  fs.chmodSync(MTPROXY_CLASSIC_CONFIG_DIR, 0o700);
  fs.writeFileSync(MTPROXY_CLASSIC_SECRET_PATH, `${secret}\n`, { mode: 0o600 });
  fs.chmodSync(MTPROXY_CLASSIC_SECRET_PATH, 0o600);
  console.log(`>>>   Classic secret persisted in ${MTPROXY_CLASSIC_SECRET_PATH} (root-only; not logged)`);

  await run(`docker pull ${MTPROXY_CLASSIC_IMAGE}`);

  // Refuse to steal a host port from an unrelated workload. The only exception
  // is the legacy mtg container (`mtproxy`): that is the engine we are migrating
  // away from, and on this host it is known not to carry media reliably. Stop it
  // (do NOT remove it, so its config remains available) before starting classic.
  const portOwners = (await capture(`docker ps --filter publish=${MTPROXY_HOST_PORT} --format '{{.Names}}'`)).stdout
    .split('\n').map((x) => x.trim()).filter((name) => name && name !== MTPROXY_CONTAINER);
  if (portOwners.includes('mtproxy')) {
    console.log('>>> WARNING: legacy mtg container "mtproxy" owns the host port; stopping it (config is kept).');
    await run('docker stop mtproxy', { ignoreErrors: true });
  }
  const remainingOwners = portOwners.filter((name) => name !== 'mtproxy');
  if (remainingOwners.length) {
    console.error(`>>> ERROR: host port ${MTPROXY_HOST_PORT} is already published by: ${remainingOwners.join(', ')}`);
    console.error('>>>        Stop that workload explicitly, or choose another MTPROXY_PORT. Nothing was changed.');
    process.exit(1);
  }

  // Recreate only the proxy container. The /data volume (secret) survives, so
  // the Telegram link stays stable across updates and reboots.
  if (update || !appendOnly) await run(`docker rm -f ${MTPROXY_CONTAINER}`, { ignoreErrors: true });

  // The 2019 image's /run.sh hardcodes `-C 60000` and asks the kernel for
  // 65552 open files. Docker's default hard limit is 524288 on this host, but
  // making it explicit avoids failures on hosts where the default is lower
  // (`fatal: cannot raise open file limit to 65552`). Do NOT use 65536: the
  // engine needs 65552, so a hard limit of exactly 65536 makes it crash-loop.
  const runCmd = (
    `docker run -d --name ${MTPROXY_CONTAINER} --restart unless-stopped ` +
    `--ulimit nofile=524288:524288 ` +
    `-p ${MTPROXY_HOST_PORT}:${MTPROXY_CONTAINER_PORT} -v ${MTPROXY_CLASSIC_CONFIG_DIR}:/data ` +
    `${MTPROXY_CLASSIC_IMAGE}`
  ).replace(/  +/g, ' ');
  console.log(`>>> ${runCmd}`);
  const runResult = await run(runCmd, { silent: true });
  if (runResult?.code !== 0) {
    console.error(`>>> ERROR: classic MTProxy container failed to start (docker run exit ${runResult?.code ?? 'unknown'}).`);
    if (runResult?.stderr) console.error(runResult.stderr.trim());
    process.exit(1);
  }

  let status = await getContainerStatus(MTPROXY_CONTAINER);
  for (let attempt = 0; attempt < 10 && status !== 'running'; attempt++) {
    await sleep(2000);
    status = await getContainerStatus(MTPROXY_CONTAINER);
  }
  if (status !== 'running') {
    console.error(`>>> ERROR: classic MTProxy container is not running (status: ${status}).`);
    await run(`docker logs --tail 80 ${MTPROXY_CONTAINER}`, { ignoreErrors: true });
    process.exit(1);
  }

  await installClassicMss();
  saveClassicLink(secret, publicIpv4);

  console.log(`>>> MTProxy container is running (image: ${MTPROXY_CLASSIC_IMAGE}, engine: classic)`);
  console.log(`>>>   Host port ${MTPROXY_HOST_PORT} -> container port ${MTPROXY_CONTAINER_PORT}`);
  console.log(`>>>   Secret: ${config.mtproxySecret ? 'pinned via MTPROXY_SECRET in .lenv' : `persisted in ${MTPROXY_CLASSIC_SECRET_PATH}`}`);
  if (config.verifyMtproxy) await verifyClassicMtproxy();
};

const deployMtproxy = async (opts = {}) => {
  if (MTPROXY_ENGINE === 'classic') return deployMtproxyClassic(opts);
  return deployMtproxyMtg(opts);
};

const deployMtproxyMtg = async ({ appendOnly = false, forceUpdate = false } = {}) => {
  const update = forceUpdate || config.mtproxyUpdate === true;

  // Append-only mode is used to add the proxy to an ALREADY-DEPLOYED box. It
  // must never recreate/remove the proxy either: if it is running it is left
  // exactly as-is (even if .lenv now asks for a different image/port), and a
  // stopped proxy is only started, never rebuilt. --mtproxy-update is the
  // explicit opt-in that permits recreating ONLY the mtproxy container.
  if (appendOnly && !update) {
    const current = await getContainerStatus(MTPROXY_CONTAINER);
    if (current === 'running') {
      console.log(`>>> MTProxy "${MTPROXY_CONTAINER}" is already running — leaving it and hive-mind untouched.`);
      console.log(`>>>   Connection link: cat ${MTPROXY_LINK_PATH} (or docker exec ${MTPROXY_CONTAINER} /mtg access /config.toml)`);
      if (config.verifyMtproxy) await verifyMtproxy();
      return;
    }
    if (current !== 'not_found') {
      console.log(`>>> MTProxy "${MTPROXY_CONTAINER}" exists but is ${current}; starting it without recreating.`);
      const started = await run(`docker start ${MTPROXY_CONTAINER}`, { silent: true, ignoreErrors: true });
      let startedStatus = await getContainerStatus(MTPROXY_CONTAINER);
      for (let attempt = 0; attempt < 6 && started?.code === 0 && startedStatus !== 'running'; attempt++) {
        await sleep(2000);
        startedStatus = await getContainerStatus(MTPROXY_CONTAINER);
      }
      if (started?.code === 0 && startedStatus === 'running') {
        console.log(`>>> MTProxy "${MTPROXY_CONTAINER}" is running again (same container and config).`);
        console.log(`>>>   Connection link: cat ${MTPROXY_LINK_PATH}`);
        if (config.verifyMtproxy) await verifyMtproxy();
        return;
      }
      console.error(`>>> ERROR: Could not start the existing MTProxy container (status: ${startedStatus}).`);
      console.error('>>>        It was NOT removed or recreated — fix the cause (e.g. port in use) and retry.');
      await run(`docker logs --tail 80 ${MTPROXY_CONTAINER}`, { ignoreErrors: true });
      process.exit(1);
    }
  }

  const image = String(config.mtproxyImage || MTPROXY_DEFAULT_IMAGE).trim();
  const hostPort = String(config.mtproxyPort || '443').trim();
  const frontingHost = String(config.mtproxyFrontingHost || 'contabo.com').trim().toLowerCase();

  if (!/^\d+$/.test(hostPort) || Number(hostPort) < 1 || Number(hostPort) > 65535) {
    console.error(`>>> ERROR: Invalid MTPROXY_PORT "${hostPort}" (expected 1-65535).`);
    process.exit(1);
  }
  if (!/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(frontingHost) || !frontingHost.includes('.')) {
    console.error(`>>> ERROR: Invalid MTPROXY_FRONTING_HOST "${frontingHost}" (expected a DNS hostname).`);
    process.exit(1);
  }
  if (/telegrammessenger\/proxy/i.test(image)) {
    console.error('>>> ERROR: telegrammessenger/proxy is no longer supported by this script.');
    console.error(`>>>        Use the default ${MTPROXY_DEFAULT_IMAGE} (or another mtg-compatible image).`);
    process.exit(1);
  }

  const secret = buildMtproxySecret(frontingHost);
  const publicIpv4 = await detectMtproxyPublicIpv4();
  const publicIpv6 = await detectMtproxyPublicIpv6();
  if (!publicIpv4) {
    console.log('>>> WARNING: Could not determine the public IPv4; the generated link may be wrong until MTPROXY_PUBLIC_IP/SERVER_IP is set.');
  }

  // Write the config root-only and NEVER echo the secret. Reusing the persisted
  // secret is what keeps the Telegram link stable across redeploys.
  fs.mkdirSync(MTPROXY_CONFIG_DIR, { recursive: true, mode: 0o700 });
  fs.chmodSync(MTPROXY_CONFIG_DIR, 0o700);
  const configLines = [
    `secret = "${secret}"`,
    `bind-to = "0.0.0.0:${MTPROXY_CONTAINER_PORT}"`,
  ];
  if (publicIpv4) configLines.push(`public-ipv4 = "${publicIpv4}"`);
  if (publicIpv6) configLines.push(`public-ipv6 = "${publicIpv6}"`);
  configLines.push('prefer-ip = "prefer-ipv4"', '', '[domain-fronting]', `host = "${frontingHost}"`);
  fs.writeFileSync(MTPROXY_CONFIG_PATH, `${configLines.join('\n')}\n`, { mode: 0o600 });
  fs.chmodSync(MTPROXY_CONFIG_PATH, 0o600);
  console.log(`>>>   mtg config written to ${MTPROXY_CONFIG_PATH} (root-only; secret not logged)`);

  await run(`docker pull ${image}`);

  // Recreate the container so a changed image/config/port always takes effect.
  // In append-only mode without --mtproxy-update we only reach this point when
  // the container does not exist, so there is nothing to remove.
  if (update || !appendOnly) await run(`docker rm -f ${MTPROXY_CONTAINER}`, { ignoreErrors: true });

  const runCmd = (
    `docker run -d --name ${MTPROXY_CONTAINER} --restart unless-stopped ` +
    `-p ${hostPort}:${MTPROXY_CONTAINER_PORT} -v ${MTPROXY_CONFIG_PATH}:/config.toml:ro ` +
    `${image}`
  ).replace(/  +/g, ' ');
  console.log(`>>> ${runCmd}`);
  const runResult = await run(runCmd, { silent: true });
  if (runResult?.code !== 0) {
    console.error(`>>> ERROR: MTProxy container failed to start (docker run exit ${runResult?.code ?? 'unknown'}).`);
    if (runResult?.stderr) console.error(runResult.stderr.trim());
    process.exit(1);
  }

  let status = await getContainerStatus(MTPROXY_CONTAINER);
  for (let attempt = 0; attempt < 6 && status !== 'running'; attempt++) {
    await sleep(2000);
    status = await getContainerStatus(MTPROXY_CONTAINER);
  }
  if (status !== 'running') {
    console.error(`>>> ERROR: MTProxy container is not running (status: ${status}).`);
    await run(`docker logs --tail 80 ${MTPROXY_CONTAINER}`, { ignoreErrors: true });
    process.exit(1);
  }

  // `mtg access` is the cheapest proof that the running container parsed the
  // config and knows its public endpoint; it also yields the links we persist.
  const access = await capture(`docker exec ${MTPROXY_CONTAINER} /mtg access /config.toml`);
  if (access.code !== 0) {
    console.error('>>> ERROR: mtg access failed; the proxy did not load its config.');
    await run(`docker logs --tail 80 ${MTPROXY_CONTAINER}`, { ignoreErrors: true });
    process.exit(1);
  }

  console.log(`>>> MTProxy container is running (image: ${image})`);
  console.log(`>>>   Host port ${hostPort} -> container port ${MTPROXY_CONTAINER_PORT}`);
  console.log(`>>>   Secret: ${config.mtproxySecret ? 'pinned via MTPROXY_SECRET in .lenv' : `generated, persisted in ${MTPROXY_CONFIG_PATH}`}`);
  console.log(`>>>   Fronting host: ${frontingHost}`);
  await saveMtproxyLink();
  if (config.verifyMtproxy) await verifyMtproxy();
};

// Main execution
let step = 0;
const nextStep = (msg) => console.log(`>>> Step ${++step}: ${msg}`);

// ── Concurrency guard ────────────────────────────────────────────────────────
// Refuse to run if another deploy-docker.mjs is already in progress on this host.
// Two concurrent deploys race over the single `${CONTAINER}` name and the shared
// images: one creates/pauses the container while the other is mid-cleanup,
// producing "container name already in use" and a half-configured bot. This is
// exactly what an interrupted-then-restarted remote deploy caused. A PID lock
// makes the second instance fail fast and loudly instead of corrupting state.
// The lock self-heals: if the recorded PID is no longer alive (a crashed prior
// run), we reclaim it rather than deadlock forever.
const LOCK_FILE = '/tmp/deploy-docker.lock';
const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
try {
  const prev = parseInt(fs.readFileSync(LOCK_FILE, 'utf8').trim(), 10);
  if (Number.isInteger(prev) && prev !== process.pid && pidAlive(prev)) {
    console.error(`>>> ERROR: Another deploy-docker.mjs is already running (PID ${prev}, lock ${LOCK_FILE}).`);
    console.error('>>>        Refusing to run concurrently — that would race over the hive-mind container/image.');
    console.error(`>>>        If you are SURE it is dead, remove the lock: rm -f ${LOCK_FILE}`);
    process.exit(1);
  }
  if (Number.isInteger(prev)) console.log(`>>> Reclaiming stale deploy lock from dead PID ${prev}.`);
} catch { /* no lock file yet — first run */ }
fs.writeFileSync(LOCK_FILE, String(process.pid));
// Release the lock on ANY exit path (normal, error, or signal) so a future run
// is never blocked by our own leftover lock.
const releaseLock = () => { try { if (parseInt(fs.readFileSync(LOCK_FILE, 'utf8').trim(), 10) === process.pid) fs.unlinkSync(LOCK_FILE); } catch { /* already gone */ } };
process.on('exit', releaseLock);
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => { releaseLock(); process.exit(130); });
}

if (MTPROXY_ONLY && config.resetDocker) {
  console.error('>>> ERROR: --mtproxy-only cannot be combined with --reset-docker.');
  console.error('>>>        Append-only mode must not remove hive-mind images, volumes, or containers.');
  process.exit(1);
}

// ── Append-only MTProxy path ──────────────────────────────────────────────────
// Exit HERE, before the Docker reset, orphan cleanup, hive-mind pull/rm/run, and
// final image/volume pruning below. The running bot is never inspected beyond the
// proxy helper itself, so an existing deployment keeps running uninterrupted.
if (MTPROXY_ONLY) {
  nextStep('MTProxy-only: deploying the proxy without touching hive-mind');
  await deployMtproxy({ appendOnly: true, forceUpdate: config.mtproxyUpdate === true });
  console.log('>>> ✅ MTProxy-only run complete (hive-mind untouched).');
  process.exit(0);
}

if (config.resetDocker) {
  nextStep('FULL Docker reset (--reset-docker)');
  console.log('>>> WARNING: stopping ALL containers, removing ALL images, volumes, networks, and build cache on this host.');
  // Stop and remove every container. `docker ps -aq` is empty-safe via the
  // inner `[ -n "$ids" ]` guard so the script never invokes rm with no args.
  await run(`bash -c 'ids=$(docker ps -aq); if [ -n "$ids" ]; then docker stop $ids; docker rm -f $ids; else echo "(no containers)"; fi'`, { ignoreErrors: true });
  // Nuke images, volumes, networks, build cache.
  await run(`bash -c 'ids=$(docker images -aq); if [ -n "$ids" ]; then docker rmi -f $ids; else echo "(no images)"; fi'`, { ignoreErrors: true });
  await run(`docker volume prune -af`, { ignoreErrors: true });
  await run(`docker network prune -f`, { ignoreErrors: true });
  await run(`docker builder prune -af`, { ignoreErrors: true });
  await run(`docker system prune -af --volumes`, { ignoreErrors: true });
  console.log('>>> Full Docker reset complete');
  await run(`docker system df`);
}

nextStep('Checking current container status');
const initialStatus = await getContainerStatus();
console.log(`>>> Container status: ${initialStatus}`);

// Kill any isolation-task containers that survived a previous deploy. When we
// restart the bot below, in-flight task containers (UUID-named, running on the
// ACTIVE_REPO = konard/hive-mind-dind image) keep running independently — the
// NEW bot never adopts them, so they become orphans: untracked, burning CPU/RAM,
// holding multi-GB writable layers, and pinning the old image version so it can't
// be removed (leaving a duplicate hive-mind image set). The deploy must reclaim
// everything our system created, so we force-remove ALL containers on ACTIVE_REPO
// (every tag) up front, before any image cleanup. This is safe: the bot runs on
// ${CONTAINER}-configured (handled separately) and the proxy is a different image,
// so only isolation tasks match ACTIVE_REPO.
nextStep('Removing orphaned isolation-task containers (survivors of prior deploy)');
// IMPORTANT: deliver this via a base64'd script file, NOT an inline `bash -c '...'`.
// command-stream's `$` re-quotes tokens containing spaces/braces (it wraps the
// command in another `bash -c`), which silently mangled an earlier inline grep
// (matched nothing) and broke a `/tmp` glob with `")" unexpected`. Encoding the
// script to base64 and decoding it into a file on the host bypasses ALL of that
// quoting — the bytes are reproduced verbatim, then executed with bash.
//
// Selector: match task containers by their IMAGE string (grep " ${ACTIVE_REPO}:"),
// NOT by `--filter ancestor` — ancestor matching includes DESCENDANTS, so it would
// match ${CONTAINER}-configured (the bot, committed FROM ${ACTIVE_REPO}) and MISS
// the actual tagged task containers, i.e. exactly backwards. Grepping the printed
// "ID Image" lines selects only containers literally running ${ACTIVE_REPO}:<tag>
// (the UUID-named isolation tasks), never the bot or the proxy. Also wipe the
// per-task /tmp scratch (gh-issue-solver-*, solution-draft-*, codex_*/claude_*).
const reclaimScript = `#!/bin/bash
set +e
echo ">>> Removing orphaned isolation-task containers..."
ids=$(docker ps -a --format '{{.ID}} {{.Image}}' | grep " ${ACTIVE_REPO}:" | cut -d' ' -f1 | sort -u)
if [ -n "$ids" ]; then
  echo ">>> force-removing task containers: $ids"
  docker rm -f $ids
else
  echo "(no isolation-task containers)"
fi
echo ">>> Cleaning leftover task scratch in /tmp..."
rm -rf /tmp/gh-issue-solver-* /tmp/solution-draft-* /tmp/codex_* /tmp/claude_* /tmp/start-bot.sh 2>/dev/null
echo "(tmp task scratch cleaned)"
`;
const reclaimB64 = Buffer.from(reclaimScript).toString('base64');
await run(`echo ${reclaimB64} | base64 -d > /tmp/hive-reclaim.sh && bash /tmp/hive-reclaim.sh; rm -f /tmp/hive-reclaim.sh`, { ignoreErrors: true });

nextStep('Cleaning up old container and committed image');
// Force-remove the container regardless of its state. A prior deploy can be
// interrupted mid-setup and leave ${CONTAINER} behind in ANY state — running,
// created, exited, restarting, dead, or PAUSED (we hit exactly this: a
// leftover "Up (Paused)" container survived and blocked the next run's
// `docker run --name`). The old `docker stop && docker rm` was doubly broken
// for that case: (1) `docker stop` errors on a paused container, and with `&&`
// the `docker rm` then never ran; (2) plain `docker rm` (no -f) refuses to
// remove a running/paused container anyway. `docker rm -f` handles every state
// in one shot (it unpauses+kills as needed), and we DON'T chain it after stop,
// so a stop failure can't skip the removal. `docker rm -f` on a nonexistent
// container is a harmless error we ignore.
await run(`docker rm -f ${CONTAINER}`, { ignoreErrors: true });
await run(`docker images -q ${CONTAINER}-configured | grep -q . && docker rmi -f ${CONTAINER}-configured || true`, { ignoreErrors: true });

if (!config.keepInactiveVariant && INACTIVE_REPOS.length > 0) {
  nextStep('Removing inactive hive-mind variant image(s)');
  // Remove every tag of the other variant's repository so we don't keep
  // tens of GB of unused image layers. A full reset above would already
  // have cleared these; this step covers the common case (no --reset-docker).
  for (const repo of INACTIVE_REPOS) {
    await run(`bash -c 'ids=$(docker images -q ${repo}); if [ -n "$ids" ]; then docker rmi -f $ids; else echo "(no ${repo} images)"; fi'`, { ignoreErrors: true });
  }
}

nextStep('Verifying old container is gone');
// Resume-safety: the container MUST be gone before we `docker run --name` it
// again, or the run dies with a name conflict (the exact failure that broke a
// resumed deploy). `docker rm -f` above normally suffices, but be defensive
// against a slow daemon or a re-created container: re-check, and if anything
// still answers to the name, force-remove again (up to a few tries) before we
// give up. Only a container that genuinely refuses to die is fatal.
let afterCleanupStatus = await getContainerStatus();
for (let attempt = 1; attempt <= 5 && afterCleanupStatus !== 'not_found'; attempt++) {
  console.log(`>>> Container still present (status: ${afterCleanupStatus}); force-removing (attempt ${attempt}/5)...`);
  await run(`docker rm -f ${CONTAINER}`, { ignoreErrors: true });
  afterCleanupStatus = await getContainerStatus();
}
if (afterCleanupStatus !== 'not_found') {
  console.error(`>>> ERROR: Container ${CONTAINER} still exists after forced cleanup (status: ${afterCleanupStatus}). ` +
    `Remove it manually ('docker rm -f ${CONTAINER}') and re-run.`);
  process.exit(1);
}
console.log('>>> Old container removed successfully');

nextStep('Pulling latest image');
const pullResult = await run(`docker pull ${IMAGE}`);
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
await run(`docker images --digests ${IMAGE}`);

// Resolve the CONCRETE version `latest` currently points to and ensure the host
// has that exact tag — never rely on the floating `latest`. We always DEPLOY
// `latest` (so the host gets the newest image), but a `latest` tag can move under
// us; a `--isolation docker` task requests an EXACT version tag
// (HIVE_MIND_DOCKER_ISOLATION_IMAGE_TAG). In DooD mode the task `docker run`s that
// exact tag against the HOST daemon, so the host must already hold it or the run
// triggers a fresh multi-GB pull. We pull the concrete tag here (it shares all
// layers with the already-pulled `latest`, so it adds ZERO bytes — just a tag
// pointer) so the isolated task reuses it with zero copy and zero pull.
//
// Source of truth for the version: HIVE_MIND_DOCKER_ISOLATION_IMAGE_TAG in the
// image env (the exact tag a task will request), with the OCI
// org.opencontainers.image.version label as a fallback. We inspect the FULL image
// JSON (no --format) and parse in JS.
//
// CRITICAL: do NOT pass a Go `--format '{{...}}'` template through command-stream's
// `$`. command-stream auto-quotes tokens containing `{ } . space` (its smart-quoting
// special-character set), and a template with a space like `{{json .Config.Env}}`
// reaches docker malformed → "template parsing error: unclosed action" (exit 64).
// `{{.State.Status}}` happens to survive only because it has no space. So we inspect
// the FULL image JSON (no --format, no braces) and read Config.Env / Config.Labels
// in JS. See link-foundation/command-stream (brace/space token quoting).
let CHILD_IMAGE = null;
let RESOLVED_VERSION = null;
if (VARIANT.supportsIsolationModes) {
  nextStep('Resolving concrete version tag for isolation tasks (never latest)');
  const inspectResult = await $({ mirror: false })`docker image inspect ${IMAGE}`;
  let version = null;
  let cfg = {};
  try {
    const arr = JSON.parse(inspectResult.stdout.trim() || '[]');
    cfg = (arr[0] && arr[0].Config) || {};
  } catch (e) {
    console.log(`>>> WARNING: could not parse image inspect JSON (${e.message})`);
  }
  try {
    const env = cfg.Env || [];
    const tagEntry = env.find((e) => e.startsWith('HIVE_MIND_DOCKER_ISOLATION_IMAGE_TAG='));
    if (tagEntry) version = tagEntry.split('=').slice(1).join('=').trim() || null;
  } catch (e) {
    console.log(`>>> WARNING: could not read image env (${e.message})`);
  }
  if (!version) {
    try {
      const labels = cfg.Labels || {};
      version = (labels['org.opencontainers.image.version'] || '').trim() || null;
      if (version) console.log('>>> Using org.opencontainers.image.version label for concrete tag');
    } catch (e) {
      console.log(`>>> WARNING: could not read image labels (${e.message})`);
    }
  }
  // Guard: refuse to proceed with a floating tag. A task asks for the exact
  // version tag; if we cannot resolve it, the host might not hold the tag the
  // task requests and the isolated `docker run` would pull 30+ GB.
  if (!version || version === 'latest') {
    console.error(`>>> ERROR: Could not resolve a concrete version tag from ${IMAGE}.`);
    console.error('>>> Neither HIVE_MIND_DOCKER_ISOLATION_IMAGE_TAG (env) nor');
    console.error('>>> org.opencontainers.image.version (label) yielded a concrete version.');
    console.error('>>> Refusing to proceed with a floating `latest` tag (isolated task could re-pull 30+ GB).');
    process.exit(1);
  }
  RESOLVED_VERSION = version;
  CHILD_IMAGE = `${ACTIVE_REPO}:${version}`;
  console.log(`>>> Host \`latest\` resolves to concrete version: ${version}`);
  console.log(`>>> Isolation tasks will request: ${CHILD_IMAGE} (reused from host daemon, zero copy)`);
  nextStep('Ensuring concrete version tag is present on host');
  if (CHILD_IMAGE !== IMAGE) {
    // Tag-pull the concrete version. It shares every layer with the already-pulled
    // `latest`, so this adds ZERO bytes — just a tag pointer to the same image.
    await run(`docker pull ${CHILD_IMAGE}`);
  } else {
    console.log('>>> Concrete version tag matches deployment image reference');
  }
  await run(`docker images --digests ${CHILD_IMAGE}`);
}

// Remove OLD VERSION TAGS of the active variant's repo. We pull `latest` and tag
// the concrete RESOLVED_VERSION above; every PRIOR version tag (e.g. an earlier
// 2.0.13 left behind by a previous deploy) is now unused and wastes ~28 GB each.
// `docker image prune -f` below only removes *dangling* (untagged) layers, so it
// never reclaims these still-tagged old versions — we must remove them explicitly.
// We keep exactly two tags: `latest` and the concrete version this deploy resolved
// to (RESOLVED_VERSION). Anything else under ACTIVE_REPO is a stale prior release.
// `docker rmi <repo>:<tag>` only untags; shared layers stay until the new image no
// longer references them, so the active image is never harmed.
if (VARIANT.supportsIsolationModes && RESOLVED_VERSION) {
  nextStep('Removing old version tags of active hive-mind variant');
  const keepTags = new Set(['latest', RESOLVED_VERSION, ACTIVE_TAG]);
  const listResult = await run(
    `docker images ${ACTIVE_REPO} --format '{{.Tag}}'`,
    { ignoreErrors: true, silent: false }
  );
  const tags = (listResult?.stdout || '')
    .split('\n')
    .map((t) => t.trim())
    .filter(Boolean)
    .filter((t) => t !== '<none>' && !keepTags.has(t));
  if (tags.length === 0) {
    console.log(`>>> No stale ${ACTIVE_REPO} version tags to remove (kept: ${[...keepTags].join(', ')})`);
  } else {
    console.log(`>>> Removing stale ${ACTIVE_REPO} tags: ${tags.join(', ')} (keeping: ${[...keepTags].join(', ')})`);
    for (const tag of tags) {
      await run(`docker rmi ${ACTIVE_REPO}:${tag}`, { ignoreErrors: true });
    }
  }
}

// Clean up old/dangling images and reclaim disk space
await run(`docker image prune -f`, { ignoreErrors: true });
await run(`docker system prune -f`, { ignoreErrors: true });

nextStep('Starting temporary container for setup');
// Last line of defense against a name conflict: force-remove ${CONTAINER} one
// more time IMMEDIATELY before `docker run --name`. The cleanup above ran many
// steps and a multi-GB image pull ago; if anything re-created the container in
// that window (e.g. a racing orphan from an interrupted run), this clears it so
// the run below can never fail with "container name already in use" — the exact
// error that broke the last resume. Checked first so the normal case (already
// absent) does not print a misleading "No such container" error.
{
  const exists = await $({ mirror: false })`docker ps -aq --filter ${`name=^/${CONTAINER}$`}`;
  if ((exists.stdout || '').trim()) await run(`docker rm -f ${CONTAINER}`, { ignoreErrors: true });
}
// dind variant: --privileged so entrypoint can later start dockerd, but skip
// dockerd in the setup pass (we don't need it for package installs and it
// would pollute /var/lib/docker before docker commit).
await run(`docker run -dit ${MODEF.tempEnvFlags} --name ${CONTAINER} ${IMAGE}`.replace(/  +/g, ' '));

nextStep('Verifying temporary container is running');
const tempStatus = await getContainerStatus();
if (tempStatus !== 'running') {
  console.error(`>>> ERROR: Temporary container failed to start (status: ${tempStatus})`);
  process.exit(1);
}
console.log('>>> Temporary container is running');

nextStep('Fixing /home/box/.local permissions for box user');
await run(`docker exec -u root ${CONTAINER} mkdir -p /home/box/.local/share /home/box/.local/state`);
await run(`docker exec -u root ${CONTAINER} chown -R box:box /home/box/.local`);

nextStep('Checking agent --version (first access, before update)');
await dockerSh('agent --version', { ignoreErrors: true });

nextStep('Updating hive-mind, agent, claude-code, and codex');
// await dockerSh('bun install -g @link-assistant/hive-mind@1.53.0');
await dockerSh('bun install -g @link-assistant/hive-mind@latest');
await dockerSh('bun install -g @link-assistant/agent@latest');
await run(`docker exec ${VARIANT.execUserFlag} ${CONTAINER} bash -l -c "curl -fsSL https://claude.ai/install.sh | bash"`.replace(/  +/g, ' '));
await dockerSh('bun install -g @openai/codex@latest');

nextStep('Verifying claude-code version after installation');
await dockerSh('claude --version');

nextStep('Checking agent --version (after update)');
await dockerSh('agent --version', { ignoreErrors: true });

nextStep('Initializing Gemini CLI');
await dockerSh('gemini --version', { ignoreErrors: true });

nextStep('Writing bot start script');
const botStartScript = `#!/bin/bash
source ~/.bashrc
# Runtime env forwarded from top-level .lenv keys (e.g. HIVE_MIND_DISK_THRESHOLD).
${botEnvExports}
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
log('botStartScript:\n' + redact(botStartScript));
const base64Script = Buffer.from(botStartScript).toString('base64');
log('base64Script length:', base64Script.length);
// Write script to tmp, copy into container, fix ownership.
// SILENT: the base64 blob decodes to start-bot.sh which embeds the Telegram bot
// TOKEN. Printing the command would leak the secret into stdout AND the tee'd
// log file (base64 is trivially decodable). Print a redacted placeholder instead.
console.log('>>> echo <base64 start-bot.sh, redacted — contains bot token> | base64 -d > /tmp/start-bot.sh');
await run(`echo ${base64Script} | base64 -d > /tmp/start-bot.sh`, { silent: true });
await run(`docker cp /tmp/start-bot.sh ${CONTAINER}:/home/box/start-bot.sh`);
await run(`rm /tmp/start-bot.sh`);
await run(`docker exec -u root ${CONTAINER} chown box:box /home/box/start-bot.sh`);

nextStep('Checking agent --version (after configuration)');
await dockerSh('agent --version', { ignoreErrors: true });

if (MODEF.needsDockerd) {
  nextStep('Cleaning /var/lib/docker before commit (dind mode)');
  // We started the temp container with DIND_SKIP_DAEMON=1, but the directory
  // may still contain Docker base files from the image. Wipe it so the final
  // container's dind-entrypoint.sh starts dockerd from a clean state.
  // Using `find -delete` instead of a glob with hidden-file patterns avoids
  // shell quoting issues with `.??*` going through multiple layers of -c.
  await run(`docker exec -u root ${CONTAINER} sh -c "find /var/lib/docker -mindepth 1 -delete"`, { ignoreErrors: true });
}

nextStep('Committing container');
// DooD dind variant: the temp container ran with DIND_SKIP_DAEMON=1, which
// `docker commit` carries into the committed image — exactly what we want, since
// the final container also runs in DooD mode (no nested dockerd). finalEnvFlags
// re-asserts DIND_SKIP_DAEMON=1 at run time as belt-and-suspenders. No --change
// needed. (If a future variant re-enables a nested daemon, bake DIND_SKIP_DAEMON=0
// here.)
const commitChangeFlags = '';
await run(`docker commit ${commitChangeFlags} ${CONTAINER} ${CONTAINER}-configured`.replace(/  +/g, ' '));
await run(`docker stop ${CONTAINER}`);
await run(`docker rm ${CONTAINER}`);

nextStep('Ensuring host mount directories exist');
await run(`mkdir -p /root/.hive-mind/claude /root/.hive-mind/codex /root/.hive-mind/gh`);
// claude.json is bind-mounted as a FILE (see MOUNTS below), so the source MUST
// exist before `docker run` — otherwise Docker auto-creates it as a DIRECTORY and
// breaks .claude.json entirely. But it must NOT be an EMPTY file: claude parses it
// as JSON on startup and an empty file is "JSON Parse error: Unexpected EOF",
// which it reports as corrupted (it self-heals, but noisily). So seed a valid
// empty JSON object `{}` when the file is missing OR zero-length, and otherwise
// leave a real existing config (e.g. restored from the mirror) untouched.
await run(`[ -s /root/.hive-mind/claude.json ] || printf '{}' > /root/.hive-mind/claude.json`);
// NOTE: .gitconfig is deliberately NOT bind-mounted as a file. git writes its
// config via a temp-file + atomic rename, which fails with "Device or resource
// busy" when the target is a single-file bind mount (you cannot rename over a
// mountpoint). So gh-setup-git-identity must write to a NON-mounted path inside
// the container; we then copy the result out to the host for DooD task mounts
// (see "Persisting git identity" step after gh-setup-git-identity below).

if (MODEF.isDooD) {
  nextStep('Wiring DooD isolation-task config paths on host (symlinks to real config)');
  // In DooD, isolation tasks run on the HOST daemon. hive-mind's isolation runner
  // builds the task's bind-mount SOURCES from the bot's homedir (/home/box/...):
  //   /home/box/.config/gh, /home/box/.claude, /home/box/.claude.json,
  //   /home/box/.codex, /home/box/.gitconfig
  // Those source paths are resolved on the HOST at task-run time. They do not
  // exist there, so Docker auto-creates them as EMPTY DIRECTORIES, which then
  // fails to bind onto the container's FILE paths (.claude.json/.gitconfig):
  //   "error mounting ... not a directory: Are you trying to mount a directory
  //    onto a file (or vice-versa)?"  → the isolated task dies before it starts.
  // (In DinD this never happened: the task ran on the NESTED daemon, which shares
  //  the bot's filesystem, so /home/box/.claude.json was the real file.)
  //
  // This is a hive-mind DooD-support gap (it should resolve mount sources to host
  // paths in DooD) — reported in link-assistant/hive-mind#1962. Deploy-side
  // workaround: make the host paths hive-mind references resolve, via symlinks, to
  // the bot's REAL config under /root/.hive-mind/*. Docker follows symlink mount
  // sources, so every task reuses the same real credentials with correct types.
  //
  // .gitconfig is handled LATER (after gh-setup-git-identity writes it to the
  // container FS, then we copy it to /root/.hive-mind/gitconfig and symlink it),
  // because it cannot be a file bind mount (git atomic-rename → "resource busy").
  const dooDLinks = [
    ['/root/.hive-mind/gh', '/home/box/.config/gh'],
    ['/root/.hive-mind/claude', '/home/box/.claude'],
    ['/root/.hive-mind/claude.json', '/home/box/.claude.json'],
    ['/root/.hive-mind/codex', '/home/box/.codex'],
  ];
  await run(`mkdir -p /home/box/.config`);
  for (const [target, linkPath] of dooDLinks) {
    // Remove any leftover (Docker auto-created empty dir, or a stale link), then
    // create the symlink. `ln -sfn` replaces an existing symlink atomically but
    // refuses to replace a non-empty dir, so we rm -rf the leftover first. These
    // leftovers are always empty Docker placeholders (no real box user on host).
    await run(`bash -c 'rm -rf ${linkPath} && ln -sfn ${target} ${linkPath}'`);
  }
  await run(`bash -c 'echo "DooD task-config symlinks:"; ls -la /home/box /home/box/.config'`, { ignoreErrors: true });
}

nextStep('Making the Formal AI memory/log volume writable for box');
// The bot starts the Formal AI sidecar with the named volume
// hive-mind-formal-ai-memory on /home/box/.formal-ai, where formal-ai keeps
// its memory (memory.lino) and its complete dialog logs (logs/; verbose is
// formal-ai's default). hive-mind chowns the volume only when it creates it,
// so a volume created earlier stays root-owned: formal-ai (running as box)
// then logs "Permission denied" for every exchange and keeps no logs at all.
// A missing volume is left to hive-mind, which creates it owned by box.
await run(`bash -c 'if docker volume inspect hive-mind-formal-ai-memory >/dev/null 2>&1; then docker run --rm --volume hive-mind-formal-ai-memory:/home/box/.formal-ai --entrypoint chown ${IMAGE} -R box:box /home/box/.formal-ai && docker run --rm --volume hive-mind-formal-ai-memory:/home/box/.formal-ai --entrypoint ls ${IMAGE} -ld /home/box/.formal-ai; else echo "hive-mind-formal-ai-memory does not exist yet (hive-mind creates it owned by box)"; fi'`, { ignoreErrors: true });

nextStep('Starting final container with bot');
// Using -dit so docker attach works with Ctrl+P, Ctrl+Q to detach
// Volume mounts persist claude config, codex config, claude.json, gh auth, and
// git identity across restarts/rebuilds.
const MOUNTS = [
  '-v /root/.hive-mind/claude:/home/box/.claude',
  '-v /root/.hive-mind/codex:/home/box/.codex',
  '-v /root/.hive-mind/claude.json:/home/box/.claude.json',
  '-v /root/.hive-mind/gh:/home/box/.config/gh',
  // No .gitconfig mount: git's atomic-rename writes break on a single-file bind
  // mount. It is written to the container FS by gh-setup-git-identity and copied
  // to the host for DooD task mounts afterward.
].join(' ');
// DooD: the box user (UID 1001) must be able to READ the host docker socket
// mounted at /var/run/docker.sock, or `docker` inside the bot cannot reach the
// host daemon. The socket bind-mounts in with its numeric HOST group (the host's
// `docker` group, e.g. GID 988), which does NOT match box's in-container docker
// group. Add box to the host socket's GID via --group-add. GID is read live from
// the host socket (not hardcoded) so a host docker reinstall that renumbers the
// group is handled automatically. (The image's entrypoint also runs
// fix_socket_permissions, but --group-add guarantees access regardless.)
// Both modes mount a host docker socket that box must be able to READ:
//   dood - /var/run/docker.sock (the real runtime)
//   dind - /var/run/host-docker.sock:ro (seed source for passthrough)
// The socket bind-mounts in with its numeric HOST group (the host's `docker`
// group, e.g. GID 988), which does NOT match box's in-container docker group, so
// box cannot reach it without help. Add box to that GID via --group-add (read
// live from the host socket, so a docker reinstall that renumbers the group is
// handled automatically). The image entrypoint also runs fix_socket_permissions,
// but --group-add guarantees access from the first second.
let socketGroupFlag = '';
if (MODEF.isDooD || MODEF.needsDockerd) {
  const gidProbe = await $({ mirror: false })`stat -c %g /var/run/docker.sock`;
  const hostDockerGid = (gidProbe.stdout || '').trim();
  if (/^\d+$/.test(hostDockerGid)) {
    socketGroupFlag = `--group-add ${hostDockerGid}`;
    console.log(`>>> Host docker socket GID: ${hostDockerGid} (added to box via --group-add for ${MODE})`);
  } else {
    console.log(`>>> WARNING: could not determine host docker socket GID (got "${hostDockerGid}"); docker socket access may fail`);
  }
}

// DinD mode only: pin the passthrough allowlist to the CONCRETE version tag so the
// nested daemon seeds exactly the tag a task requests (never floating `latest`).
// DooD mode needs no allowlist (no nested daemon to seed).
let passthroughImagesFlag = '';
if (MODEF.needsDockerd && CHILD_IMAGE) {
  passthroughImagesFlag = `-e DIND_HOST_PASSTHROUGH_IMAGES="${CHILD_IMAGE}"`;
}

// runFlags carries the mode's socket mount(s) and privileged-or-not. finalUserFlag
// is empty for dind (image defaults to box).
await run(`docker run -dit ${MODEF.runFlags} ${MODEF.finalEnvFlags} ${passthroughImagesFlag} ${socketGroupFlag} ${VARIANT.finalUserFlag} ${VARIANT.entrypointFlag} --name ${CONTAINER} --restart unless-stopped ${MOUNTS} ${CONTAINER}-configured bash -l -c 'bash /home/box/start-bot.sh'`.replace(/  +/g, ' '));

nextStep('Verifying final container is running');
const finalStatus = await getContainerStatus();
if (finalStatus !== 'running') {
  console.error(`>>> ERROR: Final container failed to start (status: ${finalStatus})`);
  process.exit(1);
}
console.log('>>> Final container is running');

if (MODEF.needsDockerd) {
  nextStep('Waiting for nested dockerd to be ready');
  // Dockerd with the vfs storage driver can take a while to initialize on
  // first start, especially on slower disks. Be generous with the timeout.
  const dockerdTimeoutMs = 180000;
  const dockerdDeadline = Date.now() + dockerdTimeoutMs;
  let dockerdReady = false;
  let lastLogged = 0;
  let lastLogTail = '';
  while (Date.now() < dockerdDeadline) {
    // No -u override: the dind image defaults USER to box (hive-mind 1.74.3+),
    // and box is in the docker group so it can talk to /var/run/docker.sock.
    const probe = await $({ mirror: false })`docker exec ${CONTAINER} docker info`;
    if (probe.code === 0) {
      dockerdReady = true;
      break;
    }
    const elapsedMs = dockerdTimeoutMs - (dockerdDeadline - Date.now());
    if (elapsedMs - lastLogged >= 15000) {
      // Peek at dockerd.log so the operator can see WHY it's not ready,
      // not just that it isn't. Only print the tail when it changes.
      // The entrypoint may fall back from /var/log/dockerd.log to
      // /tmp/dockerd.log to /dev/null, so try both real paths.
      const logProbe = await $({ mirror: false })`docker exec -u root ${CONTAINER} sh -c "tail -5 /var/log/dockerd.log 2>/dev/null || tail -5 /tmp/dockerd.log 2>/dev/null"`;
      const logTail = (logProbe.stdout || '').trim();
      const procProbe = await $({ mirror: false })`docker exec -u root ${CONTAINER} sh -c "pgrep -a dockerd 2>/dev/null || echo NO_DOCKERD_PROCESS"`;
      const procInfo = (procProbe.stdout || '').trim();
      console.log(`>>> still waiting for dockerd... (${Math.round(elapsedMs / 1000)}s elapsed)`);
      console.log(`>>>   dockerd process: ${procInfo}`);
      if (logTail && logTail !== lastLogTail) {
        console.log(`>>>   dockerd.log tail:`);
        for (const line of logTail.split('\n')) console.log(`>>>     ${line}`);
        lastLogTail = logTail;
      }
      lastLogged = elapsedMs;
    }
    await sleep(3000);
  }
  if (!dockerdReady) {
    console.error(`>>> ERROR: Nested dockerd did not become ready in ${dockerdTimeoutMs / 1000}s`);
    console.error('>>> --- diagnostics ---');
    await run(`docker inspect --format 'Privileged={{.HostConfig.Privileged}} Entrypoint={{.Config.Entrypoint}} Cmd={{.Config.Cmd}}' ${CONTAINER}`, { ignoreErrors: true });
    await run(`docker exec -u root ${CONTAINER} sh -c 'ls -la /usr/local/bin/dind-entrypoint.sh 2>&1 || echo "ENTRYPOINT MISSING"'`, { ignoreErrors: true });
    await run(`docker exec -u root ${CONTAINER} sh -c 'ls -la /var/run/docker.sock 2>&1 || echo "docker.sock not present"'`, { ignoreErrors: true });
    await run(`docker exec -u root ${CONTAINER} sh -c 'pgrep -a dockerd 2>&1 || echo "dockerd process not running"'`, { ignoreErrors: true });
    await run(`docker exec -u root ${CONTAINER} sh -c 'for f in /var/log/dockerd.log /tmp/dockerd.log; do if [ -s "$f" ]; then echo "--- $f ---"; tail -50 "$f"; fi; done; [ -s /var/log/dockerd.log ] || [ -s /tmp/dockerd.log ] || echo "no dockerd.log at /var/log or /tmp"'`, { ignoreErrors: true });
    await run(`docker logs --tail 80 ${CONTAINER}`, { ignoreErrors: true });
    process.exit(1);
  }
  console.log('>>> Nested dockerd is ready');

  nextStep('Verifying host-image passthrough seeded the nested daemon');
  // Authoritative check: ask the NESTED dockerd whether the concrete child
  // isolation image is present. box-dind copies the host's images into the
  // nested daemon at startup ONLY when the host socket is mounted at
  // /var/run/host-docker.sock and the allowlist matches; a misconfig leaves
  // the nested store empty and the first `--isolation docker` task silently
  // re-pulls 30+ GB. We FAIL the deploy here so that never reaches production.
  // The image is inspected against the nested daemon via the in-container
  // `docker` CLI (talks to the nested socket), not the host CLI.
  //
  // IMPORTANT timing: box-dind's entrypoint reports "dockerd ready" and lets the
  // bot start while passthrough's `docker save | docker load` of the ~28 GB image
  // is still streaming in the background (it does NOT block startup on the copy).
  // So we cannot check once — we POLL until the concrete image appears, watching
  // the in-container `docker load` process so we can tell "still copying" from
  // "copy died / never started". Generous deadline: a 28 GB save|load over the
  // loopback socket can take many minutes on slower disks.
  const passthroughTarget = CHILD_IMAGE || IMAGE;
  // Template-free existence check against the NESTED daemon: full `docker image
  // inspect` (no --format / no `{{ }}`, which command-stream would mangle); we only
  // need the exit code (0 = present).
  const isSeeded = async () => {
    const r = await $({ mirror: false })`docker exec ${CONTAINER} docker image inspect ${passthroughTarget}`;
    return r.code === 0;
  };
  const seedTimeoutMs = 1800000; // 30 min — covers a cold ~28 GB save|load
  const seedDeadline = Date.now() + seedTimeoutMs;
  let seeded = await isSeeded();
  let lastSeedLog = 0;
  while (!seeded && Date.now() < seedDeadline) {
    const elapsedMs = seedTimeoutMs - (seedDeadline - Date.now());
    if (elapsedMs - lastSeedLog >= 15000) {
      // Is a copy actually in flight? A `docker load` runs inside the container
      // during passthrough; its absence (before the image lands) means the copy
      // already finished-or-failed, so we should stop waiting soon. `pgrep -fa`
      // is passed as one interpolated arg so command-stream quotes it safely.
      const loadProc = await $({ mirror: false })`docker exec ${CONTAINER} pgrep -fa ${'docker load'}`;
      const loadInfo = (loadProc.stdout || '').trim();
      console.log(`>>> waiting for passthrough to seed ${passthroughTarget}... (${Math.round(elapsedMs / 1000)}s elapsed)`);
      console.log(`>>>   in-container load process: ${loadInfo || 'none'}`);
      lastSeedLog = elapsedMs;
    }
    await sleep(5000);
    seeded = await isSeeded();
  }
  if (seeded) {
    console.log(`>>> Host-image passthrough OK: ${passthroughTarget} is present in the nested daemon`);
  } else {
    console.error(`>>> ERROR: Host-image passthrough FAILED — ${passthroughTarget} is NOT present in the nested daemon.`);
    console.error('>>> The first `--isolation docker` task would re-pull the multi-GB image inside the container.');
    console.error('>>> Likely causes: host socket not mounted at /var/run/host-docker.sock, the host is');
    console.error('>>> missing that exact tag, or DIND_HOST_PASSTHROUGH dropped it. --- diagnostics ---');
    // These probes run via $() argv (no `bash -c '<command>'` wrapper), so spaces
    // and quotes in patterns like "did NOT seed" / "WITH WARNINGS" are safe — the
    // earlier run()-wrapped versions corrupted under nested single quotes.
    //
    // What the entrypoint reported. box 2.3.4+ prints "finished WITH WARNINGS"
    // instead of "complete" when a concrete allowlist entry was not seeded, and
    // logs the access reason (e.g. "host docker socket ... is not accessible").
    const entLogs = await $({ mirror: false })`docker logs ${CONTAINER}`;
    const entInteresting = `${entLogs.stdout || ''}\n${entLogs.stderr || ''}`
      .split('\n')
      .filter((l) => /passthrough|preload|host.?docker|socket|did not seed|with warnings/i.test(l))
      .slice(-40);
    console.error('>>> entrypoint passthrough log lines:');
    for (const l of entInteresting.length ? entInteresting : ['(none found)']) console.error(`>>>   ${l}`);
    // Confirm the host socket bind-mount actually landed, and whether box can
    // read it (the common failure: socket present but wrong group → unreadable).
    await run(`docker inspect --format '{{range .Mounts}}{{.Source}} -> {{.Destination}} ({{.Mode}}){{println}}{{end}}' ${CONTAINER}`, { ignoreErrors: true });
    const sockLs = await $({ mirror: false })`docker exec -u root ${CONTAINER} ls -la /var/run/host-docker.sock`;
    console.error(`>>> host-docker.sock inside container: ${(sockLs.stdout || sockLs.stderr || '').trim() || '(not present)'}`);
    const boxId = await $({ mirror: false })`docker exec ${CONTAINER} id`;
    console.error(`>>> box identity inside container: ${(boxId.stdout || '').trim()}`);
    // What the nested daemon actually has.
    await run(`docker exec ${CONTAINER} docker images --digests`, { ignoreErrors: true });
    process.exit(1);
  }
}

if (MODEF.isDooD) {
  nextStep('Verifying DooD: bot reaches host daemon and isolation image is present');
  // DooD requires two things to be true for zero-copy isolation to work:
  //   1. the bot's `docker` (talking to the mounted host socket) can reach the
  //      HOST daemon — i.e. `docker info` succeeds inside the container;
  //   2. the concrete isolation image is already present on that daemon, so a
  //      `--isolation docker` task reuses it with ZERO copy / ZERO pull.
  // Both are inspected via the in-container `docker` CLI, which (in DooD) talks
  // to the HOST daemon. We FAIL the deploy if either is false.
  const infoProbe = await $({ mirror: false })`docker exec ${CONTAINER} docker info`;
  if (infoProbe.code !== 0) {
    console.error('>>> ERROR: DooD docker access FAILED — bot cannot reach the host daemon via the mounted socket.');
    console.error('>>> Likely causes: host socket not mounted at /var/run/docker.sock, or box lacks the socket GID.');
    console.error('>>> --- diagnostics ---');
    await run(`docker inspect --format '{{range .Mounts}}{{.Source}} -> {{.Destination}} ({{.Mode}}){{println}}{{end}}' ${CONTAINER}`, { ignoreErrors: true });
    const sockLs = await $({ mirror: false })`docker exec -u root ${CONTAINER} ls -la /var/run/docker.sock`;
    console.error(`>>> /var/run/docker.sock inside container: ${(sockLs.stdout || sockLs.stderr || '').trim() || '(not present)'}`);
    const boxId = await $({ mirror: false })`docker exec ${CONTAINER} id`;
    console.error(`>>> box identity inside container: ${(boxId.stdout || '').trim()}`);
    await run(`docker logs --tail 40 ${CONTAINER}`, { ignoreErrors: true });
    process.exit(1);
  }
  console.log('>>> DooD docker access OK: bot reaches the host daemon');

  const isolationTarget = CHILD_IMAGE || IMAGE;
  // Template-free existence check (no `{{ }}` — command-stream would mangle it):
  // full `docker image inspect`; exit 0 = present on the host daemon.
  const presence = await $({ mirror: false })`docker exec ${CONTAINER} docker image inspect ${isolationTarget}`;
  if (presence.code === 0) {
    console.log(`>>> DooD image reuse OK: ${isolationTarget} is already present on the host daemon (zero-copy, no pull on first task)`);
  } else {
    console.error(`>>> ERROR: ${isolationTarget} is NOT present on the host daemon.`);
    console.error('>>> A `--isolation docker` task would pull the multi-GB image on first run.');
    console.error('>>> The deploy pulls this concrete tag onto the host earlier; check that step succeeded.');
    await run(`docker exec ${CONTAINER} docker images --digests`, { ignoreErrors: true });
    process.exit(1);
  }
}

nextStep('Fixing mount permissions');
// Detect the actual UID of the box user from the running container
const idResult = await run(`docker exec ${CONTAINER} id -u box`);
const uidGid = idResult.stdout.trim();
log(`Detected UID: ${uidGid}`);
await run(`chown -R ${uidGid}:${uidGid} /root/.hive-mind/claude /root/.hive-mind/codex /root/.hive-mind/gh`);
await run(`chown ${uidGid}:${uidGid} /root/.hive-mind/claude.json`);

nextStep('Checking agent --version (final container)');
await dockerSh('agent --version');

nextStep('Restoring Playwright MCP for claude and codex (mounts shadow image config)');
// The host volume mounts for ~/.claude.json and ~/.codex/ shadow whatever was
// baked into the image, so playwright MCP registration must be re-applied
// inside the running final container so it persists on the host.
// Commands mirror those in the upstream Dockerfile:
//   https://raw.githubusercontent.com/link-assistant/hive-mind/refs/heads/main/Dockerfile
const PLAYWRIGHT_MCP_ARGS = '-y @playwright/mcp@latest --isolated --headless --no-sandbox --timeout-action=600000 --viewport-size 1920x1080';

// Combine stdout+stderr from a dockerSh result. command-stream's exec may
// place mcp list output on either stream depending on the CLI.
const collectOutput = (r) => `${r?.stdout ?? ''}\n${r?.stderr ?? ''}`;

// Claude: check if 'playwright' MCP is connected; if not, (re)register it at user scope.
const claudeListResult = await dockerSh('claude mcp list', { ignoreErrors: true });
const claudeMcpList = collectOutput(claudeListResult);
const claudeHasPlaywright = /\bplaywright\b.*(?:[✓✔]\s*Connected|: connected)/im.test(claudeMcpList);
if (claudeHasPlaywright) {
  console.log('>>> Claude playwright MCP already connected');
} else {
  console.log('>>> Claude playwright MCP missing or broken, restoring...');
  await dockerSh('claude mcp remove playwright -s user', { ignoreErrors: true });
  await dockerSh(`claude mcp add playwright -s user -- npx ${PLAYWRIGHT_MCP_ARGS}`);
  const verifyResult = await dockerSh('claude mcp list', { ignoreErrors: true });
  const verifyOut = collectOutput(verifyResult);
  if (/\bplaywright\b.*(?:[✓✔]\s*Connected|: connected)/im.test(verifyOut)) {
    console.log('>>> Claude playwright MCP restored');
  } else {
    // WARN-CLOSED (not fatal): the `mcp add` succeeded; a non-match here is usually
    // the CLI's status WORDING drifting (we pull @latest each deploy) or the MCP not
    // yet reporting "Connected". Playwright MCP is an optional task capability, not
    // required for the bot to run — don't fail the whole deploy over a status-string
    // mismatch. Warn and continue.
    console.log('>>> WARNING: Claude playwright MCP was added but did not report "Connected" (CLI wording may have changed). Continuing.');
    if (verifyOut.trim()) console.log(`>>>          claude mcp list: ${verifyOut.trim().split('\n').slice(0, 4).join(' | ')}`);
  }
}

// Codex: same pattern. `codex mcp list` prints registered servers; absence means it needs adding.
const codexListResult = await dockerSh('codex mcp list', { ignoreErrors: true });
const codexMcpList = collectOutput(codexListResult);
const codexHasPlaywright = /\bplaywright\b.*\benabled\b/im.test(codexMcpList);
if (codexHasPlaywright) {
  console.log('>>> Codex playwright MCP already registered');
} else {
  console.log('>>> Codex playwright MCP missing, restoring...');
  await dockerSh('codex mcp remove playwright', { ignoreErrors: true });
  await dockerSh(`codex mcp add playwright -- npx ${PLAYWRIGHT_MCP_ARGS}`);
  const verifyResult = await dockerSh('codex mcp list', { ignoreErrors: true });
  const verifyOut = collectOutput(verifyResult);
  if (/\bplaywright\b.*\benabled\b/im.test(verifyOut)) {
    console.log('>>> Codex playwright MCP restored');
  } else {
    // WARN-CLOSED (not fatal): same rationale as claude above — the add succeeded,
    // and a non-match is usually a CLI status-wording drift, not a real failure.
    console.log('>>> WARNING: Codex playwright MCP was added but did not report "enabled" (CLI wording may have changed). Continuing.');
    if (verifyOut.trim()) console.log(`>>>          codex mcp list: ${verifyOut.trim().split('\n').slice(0, 4).join(' | ')}`);
  }
}

nextStep('Verifying gh');
{
  const ghProbe = await dockerSh('gh api rate_limit --jq .resources.core', { ignoreErrors: true });
  const ghOut = `${ghProbe?.stdout || ''}\n${ghProbe?.stderr || ''}`;
  const ghOk = ghProbe && ghProbe.code === 0 && !/gh auth login|GH_TOKEN|not logged/i.test(ghOut);
  if (ghOk) {
    console.log('>>> gh is working');
  } else {
    // Not authenticated (fresh box: no gh token). Do NOT fail the deploy.
    await handleUnauthenticated('gh', 'gh auth login', 'GitHub CLI has no token — the bot cannot open PRs/issues until you authenticate.');
  }
}

nextStep('Verifying claude');
// `claude -p` can return exit 0 even when it produced no model output —
// e.g. when the account hit a usage limit ("You've hit your weekly limit").
// Treat known quota messages as a soft warning (the deploy is not broken,
// the Anthropic account is rate-limited) and a real model reply as success.
{
  const claudeCmd = 'claude -p "reply with only the literal token OK_CLAUDE_PROBE" --model haiku';
  const claudeProbe = await $({ mirror: false })`docker exec ${CONTAINER} bash -l -c ${claudeCmd}`;
  const claudeOut = `${claudeProbe.stdout || ''}\n${claudeProbe.stderr || ''}`;
  log(`claude output:\n${claudeOut}`);
  const quotaExhausted = /weekly limit|usage limit|rate limit|quota/i.test(claudeOut);
  const modelReplied = /OK_CLAUDE_PROBE/.test(claudeOut);
  // Fresh box: no credentials. `claude -p` prints "Not logged in · Please run
  // /login" (or "Invalid API key"). This is NOT a deploy failure — warn + let
  // the operator log in (interactively if --interactive-login), then continue.
  const notLoggedIn = /not logged in|please run \/login|run `?\/login`?|invalid api key|no credentials/i.test(claudeOut);
  if (modelReplied) {
    console.log('>>> claude is working (model returned probe token)');
  } else if (notLoggedIn) {
    await handleUnauthenticated('claude', 'claude /login', 'Claude Code has no credentials on this fresh box.');
  } else if (quotaExhausted) {
    // Use console.log (stdout), not console.warn (stderr): SSH multiplexes
    // the two streams without ordering guarantees, so a stderr warning here
    // can appear AFTER the next step's header, confusing the log timeline.
    console.log('>>> WARNING: claude reached a quota/usage limit — CLI is installed and authenticated, but model did not reply');
    console.log(`>>> ${claudeOut.trim().split('\n')[0]}`);
  } else {
    // WARN-CLOSED (not fatal): the CLI is installed (Step 15 verified `claude
    // --version`); any remaining non-success here is almost always an auth or
    // billing/API condition we didn't explicitly pattern-match (e.g. a 403, a new
    // "credit balance too low" wording, an org-verification prompt). Per policy,
    // auth/billing must NEVER fail the deploy — the bot starts and runs regardless;
    // the operator just needs to fix the account. Warn and continue instead of exit.
    console.log('>>> WARNING: claude did not return the probe token and was not recognized as logged-in/quota — likely an auth or billing/API condition.');
    console.log('>>>          The CLI is installed; the bot will run, but claude tasks need a working/authenticated account.');
    console.log(`>>>          To log in / check: docker exec -it ${CONTAINER} bash -lc 'claude /login'`);
    if (claudeOut.trim()) console.log(`>>>          claude said: ${claudeOut.trim().split('\n').slice(0, 3).join(' | ')}`);
  }
}

nextStep('Verifying codex');
// `codex exec` has two known false-positive shapes we must defend against:
//
// 1. Trust-gate refusal: without --skip-git-repo-check or a trusted cwd, codex
//    prints "Not inside a trusted directory..." and exits 0. We pass
//    --skip-git-repo-check to clear that gate.
// 2. Echoed-prompt false success: codex prints the user prompt verbatim in a
//    `user\n<prompt>\n` block before any model reply, so a naive substring
//    check for the probe token matches the echo even when the model never
//    responded. We require the token to appear AFTER a model-reply section
//    marker (`codex\n` per codex's output format) OR for the token to occur
//    more than once (prompt echo + reply).
// 3. Quota / usage-limit exhaustion: codex exits non-zero with
//    "You've hit your usage limit". This is a billing condition, not a deploy
//    failure — auth works, CLI works. Treat as a soft warning, mirroring the
//    claude path.
{
  // No --model: use the account's configured default. A hard-coded model is a
  // false negative waiting to happen — 2026-10-07: gpt-5.4-mini returned HTTP 400
  // "not supported when using Codex with a ChatGPT account" on a working login.
  // </dev/null stops codex waiting on (and announcing) "additional input from stdin".
  const codexCmd = 'codex exec --skip-git-repo-check "reply with only the literal token OK_CODEX_PROBE" </dev/null';
  const codexProbe = await $({ mirror: false })`docker exec ${CONTAINER} bash -l -c ${codexCmd}`;
  const codexOut = `${codexProbe.stdout || ''}\n${codexProbe.stderr || ''}`;
  log(`codex output:\n${codexOut}`);
  const refusedTrust = /Not inside a trusted directory|--skip-git-repo-check was not specified/i.test(codexOut);
  const quotaExhausted = /usage limit|rate limit|quota|insufficient_quota|purchase more credits/i.test(codexOut);
  // Fresh box: codex has no auth. It may print human phrases ("Not logged in" /
  // "run `codex login`" / "You are not signed in") OR — as seen on a fresh box —
  // fail at the HTTP layer with `401 Unauthorized` / "Missing bearer or basic
  // authentication" from wss/https://api.openai.com. A 401 is definitionally
  // "not authenticated", so treat it the same: NOT a deploy failure — warn +
  // optional interactive login, then continue (mirrors gh/claude).
  const notLoggedIn = /not logged in|not signed in|codex login|run `?codex login`?|please (?:log|sign) in|no credentials|authentication required|401 unauthorized|missing bearer|missing bearer or basic authentication/i.test(codexOut);
  // Token must appear after a `codex\n` model-reply marker, OR appear at
  // least twice (once echoed in `user\n<prompt>\n`, once in a model reply).
  const tokenAfterCodexMarker = /\ncodex\s*\n[\s\S]*OK_CODEX_PROBE/.test(codexOut);
  const tokenCount = (codexOut.match(/OK_CODEX_PROBE/g) || []).length;
  const modelReplied = tokenAfterCodexMarker || tokenCount >= 2;

  if (modelReplied) {
    console.log('>>> codex is working (model returned probe token)');
  } else if (notLoggedIn) {
    await handleUnauthenticated('codex', 'codex login', 'Codex has no credentials on this fresh box.');
  } else if (quotaExhausted) {
    // Use console.log (stdout), not console.warn (stderr): SSH multiplexes
    // the two streams without ordering guarantees.
    console.log('>>> WARNING: codex reached a usage/quota limit — CLI is installed and authenticated, but model did not reply');
    const quotaLine = (codexOut.match(/.*(?:usage limit|rate limit|quota|insufficient_quota|purchase more credits).*/i) || [])[0];
    if (quotaLine) console.log(`>>> ${quotaLine.trim()}`);
  } else {
    // WARN-CLOSED (not fatal): the CLI is installed (Step 14 installed @openai/codex
    // and it ran). Any remaining non-success — the trust gate (shouldn't happen, we
    // pass --skip-git-repo-check), an unclassified auth/billing/API condition (403,
    // "credit balance too low", org-verification, a new phrasing), or an echoed-only
    // prompt — is NOT worth failing the whole deploy over: the bot starts and runs
    // regardless, and codex tasks just need a working/authenticated account. Warn
    // and continue instead of exit, matching the gh/claude policy.
    const why = refusedTrust ? 'trust gate' : (codexProbe.code !== 0 ? `exit ${codexProbe.code}` : 'no probe token');
    console.log(`>>> WARNING: codex did not confirm working (${why}) — likely an auth or billing/API condition.`);
    console.log('>>>          The CLI is installed; the bot will run, but codex tasks need a working/authenticated account.');
    console.log(`>>>          To log in / check: docker exec -it ${CONTAINER} bash -lc 'codex login'`);
    // Show the error lines, not the first lines (those are only codex's banner).
    const lines = codexOut.split('\n').map((l) => l.trim()).filter(Boolean);
    const errLines = lines.filter((l) => /error|unsupported|not supported|denied|forbidden/i.test(l));
    const shown = [...new Set(errLines.length ? errLines : lines.slice(-3))].slice(0, 3);
    if (shown.length) console.log(`>>>          codex said: ${shown.join(' | ')}`);
  }
}

nextStep('Verifying interactive shell behavior');
// Both variants must default `docker exec hive-mind ...` to the box user
// (matching parity since hive-mind 1.74.3 / box-dind 2.1.4 fixed the
// historical dind "exec lands as root" regression).
const defaultExecProbe = await $({ mirror: false })`docker exec ${CONTAINER} whoami`;
const defaultExecUser = (defaultExecProbe.stdout || '').trim();
console.log(`>>> docker exec ${CONTAINER} whoami -> ${defaultExecUser}`);
if (defaultExecUser !== 'box') {
  console.error(`>>> ERROR: 'docker exec ${CONTAINER} whoami' returned '${defaultExecUser}', expected 'box'`);
  if (config.imageVariant === 'dind') {
    console.error('>>> dind image must default USER to box since 1.74.3.');
    console.error('>>> If this is a pinned older image, bump to konard/hive-mind-dind:1.74.3+.');
  }
  process.exit(1);
}

// Host-side shim so the operator gets a one-word `hive-mind-shell` command
// in both variants. Now redundant for behavior (plain `docker exec -it hive-mind bash`
// also lands as box) but kept as a stable, variant-agnostic entrypoint.
// Falls back gracefully when no TTY is attached (e.g. CI / SSH non-tty).
nextStep('Installing host-side hive-mind-shell helper');
const shellHelper = `#!/usr/bin/env bash
# Auto-generated by deploy-docker.mjs. Opens an interactive shell in
# the hive-mind container as the box user. Use -it when stdin is a TTY;
# otherwise plain exec so the helper can also be used non-interactively
# (e.g. \`hive-mind-shell -c 'docker ps'\`).
if [ -t 0 ] && [ -t 1 ]; then
  exec docker exec -it ${CONTAINER} bash -l "$@"
else
  exec docker exec ${CONTAINER} bash -l "$@"
fi
`;
const helperPath = '/usr/local/bin/hive-mind-shell';
const helperB64 = Buffer.from(shellHelper).toString('base64');
await run(`echo ${helperB64} | base64 -d > ${helperPath}`);
await run(`chmod +x ${helperPath}`);
const helperVerify = await $({ mirror: false })`${helperPath} -c whoami`;
const helperUser = (helperVerify.stdout || '').trim();
if (helperUser !== 'box') {
  console.error(`>>> ERROR: ${helperPath} produced user '${helperUser}', expected 'box'`);
  console.error(helperVerify.stderr || '');
  process.exit(1);
}
console.log(`>>> ${helperPath} -c whoami -> ${helperUser}`);

if (MODEF.needsDockerd || MODEF.isDooD) {
  const daemonLabel = MODEF.isDooD ? 'host daemon (DooD)' : 'nested daemon (dind)';
  nextStep(`Verifying docker is usable inside the container (${daemonLabel})`);
  // Run a non-trivial docker command as the box user to catch socket-permission
  // regressions. In DooD this hits the host daemon; in dind, the nested daemon.
  try {
    await dockerSh('docker version');
    await dockerSh('docker ps');
    console.log(`>>> docker is working (${daemonLabel})`);
  } catch {
    console.error('>>> ERROR: docker inside the container is not usable as box');
    await run(`docker exec -u root ${CONTAINER} sh -c 'ls -la /var/run/docker.sock'`, { ignoreErrors: true });
    process.exit(1);
  }
}

nextStep('Setting up git identity');
// gh-setup-git-identity derives the git identity from the authenticated gh account.
// CRITICAL: if gh is NOT authenticated, gh-setup-git-identity launches an
// INTERACTIVE `gh auth login` — and because the deploy runs over `ssh -tt` (a TTY),
// that login BLOCKS the whole deploy waiting for a device code (we saw an ~11-min
// stall here). Per the same rule as the gh/claude/codex verify steps, we must NOT
// block or fail on missing auth by default: probe gh first, and only run the setup
// when gh is already authenticated. Otherwise warn + continue (git identity gets
// configured automatically on the next deploy once gh is logged in). With
// --interactive-login the user opted into interactive prompts, so we run it anyway.
const ghAuthed = (await run(`docker exec ${CONTAINER} bash -l -c 'gh auth status'`, { ignoreErrors: true, silent: true }))?.code === 0;
let gitIdentityConfigured = false;
if (ghAuthed || config.interactiveLogin) {
  if (!ghAuthed) console.log('>>> gh not authenticated, but --interactive-login is set — running gh-setup-git-identity (may prompt for a login).');
  await dockerSh('gh-setup-git-identity');
  gitIdentityConfigured = true;
} else {
  console.log('>>> WARNING: gh is not authenticated — skipping git identity setup (would otherwise block on an interactive gh login).');
  console.log('>>>          Git identity will be configured automatically on the next deploy once gh is logged in.');
  console.log(`>>>          To log in now: docker exec -it ${CONTAINER} bash -lc 'gh auth login' then re-run the deploy.`);
}

if (MODEF.isDooD && gitIdentityConfigured) {
  nextStep('Persisting git identity to host for DooD isolation tasks');
  // gh-setup-git-identity wrote /home/box/.gitconfig INSIDE the container (not a
  // mount now, so git's atomic-rename write succeeds). DooD isolation tasks run on
  // the host daemon and mount host /home/box/.gitconfig as the source — which does
  // not exist on the host, so Docker would auto-create an empty dir → the task
  // gets no git identity → solve fails pre-flight ("Git identity not configured").
  // Copy the bot's freshly-written .gitconfig OUT to a host file and symlink the
  // task's mount source to it. Docker follows symlink sources, so the task gets
  // the real identity as a file. (hive-mind DooD-support gap — reported in #1962.)
  await run(`docker cp ${CONTAINER}:/home/box/.gitconfig /root/.hive-mind/gitconfig`);
  await run(`bash -c 'rm -rf /home/box/.gitconfig && ln -sfn /root/.hive-mind/gitconfig /home/box/.gitconfig'`);
  // Verify the host file carries user.name, else the next task fails pre-flight.
  const gitProbe = await $({ mirror: false })`bash -c ${'test -f /root/.hive-mind/gitconfig && grep -q "name = " /root/.hive-mind/gitconfig && echo OK'}`;
  if ((gitProbe.stdout || '').trim() === 'OK') {
    console.log('>>> DooD git identity persisted: /home/box/.gitconfig -> /root/.hive-mind/gitconfig (has user.name)');
  } else {
    console.error('>>> ERROR: git identity not persisted to host — isolation tasks would fail "Git identity not configured".');
    await run(`bash -c 'ls -la /root/.hive-mind/gitconfig 2>&1; echo ---; cat /root/.hive-mind/gitconfig 2>/dev/null'`, { ignoreErrors: true });
    process.exit(1);
  }
}

nextStep('Waiting for bot to start and verifying');
const maxWait = 60000;
const pollInterval = 5000;
let elapsed = 0;
let botStarted = false;
// Read the FULL container logs each poll (NOT `--tail 50`): the bot prints its
// "starting polling..." marker ONCE, right at startup. If an earlier step blocked
// for a while (e.g. an interactive `gh auth login` at "Setting up git identity"
// consuming several minutes while you enter the device code), the container will
// have logged many heartbeat lines by the time we poll — and a 50-line tail would
// scroll the startup marker out of view, making a HEALTHY, already-polling bot
// look like it never started (a false failure we actually hit). We also match any
// of several equivalent success markers so a wording change in one doesn't break
// detection.
const BOT_UP_MARKERS = [
  'starting polling...',
  'SwarmMindBot is now running',
  'Polling is active',
  'Bot launched successfully',
  'EVENT bot_launched',
];
while (elapsed < maxWait) {
  await sleep(pollInterval);
  elapsed += pollInterval;
  try {
    const logsResult = await $({ mirror: false })`docker logs ${CONTAINER}`;
    const logs = `${logsResult.stdout || ''}\n${logsResult.stderr || ''}`;
    if (BOT_UP_MARKERS.some((m) => logs.includes(m))) {
      botStarted = true;
      break;
    }
  } catch {
    // ignore
  }
  console.log(`>>> Waiting for bot to start... (${elapsed / 1000}s)`);
}

if (botStarted) {
  console.log('>>> Bot confirmed started (found a startup marker in logs)');
} else {
  console.error(`>>> ERROR: Bot did not log any startup marker (${BOT_UP_MARKERS.map((m) => `"${m}"`).join(', ')}) within ${maxWait / 1000}s`);
  // Dump everything we can so the failure is diagnosable from the log alone
  // (the wrapper tees all of this to deploy-remote-docker.log). Without this
  // the script exits before the "Bot logs" step below, leaving no clue why
  // the bot never started polling. All dumps ignore errors so one failing
  // command can't mask the others.
  console.error('>>> === FAILURE DIAGNOSTICS ===');
  console.error('>>> --- container status ---');
  await run(`docker ps -a --filter name=${CONTAINER}`, { ignoreErrors: true });
  console.error('>>> --- full container logs (docker logs, untruncated) ---');
  await run(`docker logs ${CONTAINER}`, { ignoreErrors: true });
  console.error('>>> --- in-container bot log (/home/box/hive-telegram-bot.log) ---');
  // The bot tees its stdout/stderr to this file from box's home dir (CWD of
  // start-bot.sh). cat as box; fall back to a note if it does not exist yet.
  await run(
    `docker exec ${VARIANT.execUserFlag} ${CONTAINER} bash -lc 'cat ~/hive-telegram-bot.log 2>/dev/null || echo "(no hive-telegram-bot.log yet — bot may have crashed before writing it)"'`.replace(/  +/g, ' '),
    { ignoreErrors: true }
  );
  console.error('>>> === END FAILURE DIAGNOSTICS ===');
  process.exit(1);
}

nextStep('Verifying container is running');
await run('docker ps -a');

if (config.mtproxy) {
  nextStep('Deploying Telegram MTProto proxy (--mtproxy) alongside hive-mind');
  await deployMtproxy();
} else {
  console.log('>>> MTProxy not requested (--mtproxy / DEPLOY_MTPROXY=true) — leaving any running proxy untouched');
}

// Final disk reclaim: remove every image and container NOT in use right now,
// sparing only an explicit keep-list. The bot container and the telegram proxy
// are both running at this point, so an "in-use" sweep protects them and their
// images automatically; we additionally pin the keep-list by image ID so the
// active hive-mind images survive even though `latest` and the committed image
// share/point at the same layers.
//
// KEEP (everything else is removed):
//   - hive-mind-configured:latest       (the committed image the bot runs)
//   - konard/hive-mind-dind:latest       (active variant, floating tag)
//   - konard/hive-mind-dind:<version>    (active variant, concrete tag from this deploy)
//   - the selected proxy image          (classic mtproxy/mtproxy by default; mtg if selected)
//   - any image referenced by a RUNNING container (belt-and-suspenders)
// CONTAINERS: every container that is not currently running is removed.
nextStep('Reclaiming disk: removing all images and containers not in use');
const KEEP_IMAGE_REFS = [
  `${CONTAINER}-configured:latest`,
  'konard/hive-mind-dind:latest',
  ...(RESOLVED_VERSION ? [`konard/hive-mind-dind:${RESOLVED_VERSION}`] : []),
  ...(config.mtproxy ? [MTPROXY_ACTIVE_IMAGE] : []),
];
// Delivered via base64'd script file (NOT inline): this body uses `{{.Image}}`
// Go-templates, embedded double-quotes, `case` blocks and `printf "%b"`, all of
// which command-stream's `$` smart-quoting mangles when wrapped in `bash -c` —
// that is exactly why an earlier inline version reclaimed 0 B. Encoding to base64
// and decoding into a file reproduces the bytes verbatim, then bash runs them.
//
// KEEP refs are pinned by FULL image ID; everything else is removed. Each step is
// best-effort (no `set -e`) so one transient docker error never aborts the reclaim.
const keepRefLines = KEEP_IMAGE_REFS
  .map((ref) => `keep="$keep\n$(docker inspect --format '{{.Id}}' ${ref} 2>/dev/null | sed 's/^sha256://')"`)
  .join('\n');
const cleanupScript = `#!/bin/bash
set +e
# 1. Remove every container that is NOT running (reaps leftover task containers).
running=$(docker ps -q)
for c in $(docker ps -aq); do
  echo "$running" | grep -qxF "$c" || { echo ">>> removing non-running container $c"; docker rm -f "$c"; }
done
# 2. Build the keep-set of FULL image IDs: images used by RUNNING containers, plus
#    the explicit keep-list refs resolved to IDs (a missing ref just yields nothing).
keep=$(docker ps -q | xargs -r docker inspect --format '{{.Image}}' 2>/dev/null | sed 's/^sha256://')
${keepRefLines}
# 3. Remove every image whose full ID is not in the keep-set (prefix match).
for id in $(docker images --no-trunc -q | sed 's/^sha256://' | sort -u); do
  match=""
  for k in $(printf "%b" "$keep" | grep .); do
    case "$id" in "$k"*) match=1;; esac
  done
  if [ -z "$match" ]; then echo ">>> removing image $id"; docker rmi -f "$id"; fi
done
# 4. Sweep dangling layers, build cache, unused networks/volumes.
docker image prune -f
docker builder prune -f
docker network prune -f
docker volume prune -f
`;
const cleanupB64 = Buffer.from(cleanupScript).toString('base64');
await run(`echo ${cleanupB64} | base64 -d > /tmp/hive-cleanup.sh && bash /tmp/hive-cleanup.sh; rm -f /tmp/hive-cleanup.sh`, { ignoreErrors: true });
console.log('>>> Disk reclaim complete. Remaining images:');
await run('docker images', { ignoreErrors: true });
await run('docker system df', { ignoreErrors: true });

nextStep('Bot logs');
await run(`docker logs --tail 30 ${CONTAINER}`);

console.log('>>> Done');
console.log('>>> To attach to bot output: docker attach hive-mind');
console.log('>>> To detach without stopping: Ctrl+P, Ctrl+Q');
console.log('>>> To open a shell as the box user: hive-mind-shell');
console.log(`>>>   (equivalent: docker exec -it ${CONTAINER} bash -l)`);
