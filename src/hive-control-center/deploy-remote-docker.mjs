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
const { makeConfig, LinoEnv } = await use('lino-arguments@0.3.0');

// --- Bootstrap: ensure .lenv.example exists and is up to date ---------------
// This script is intended to be self-contained: if a user pulls just this
// file (e.g. from a gist) and runs it without .lenv, we materialize a
// .lenv.example next to the script so they know what to fill in. If .lenv
// already exists we still refresh .lenv.example to match the canonical
// template so it does not drift.
import { existsSync, readFileSync, writeFileSync, createWriteStream, mkdirSync, statSync, lstatSync, readdirSync, rmSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LENV_PATH = resolve(__dirname, '.lenv');
const LENV_EXAMPLE_PATH = resolve(__dirname, '.lenv.example');

// --- Tee all output to a log file -------------------------------------------
// Terminal scrollback/width can truncate long deploys, so mirror everything
// written to stdout/stderr into a log file next to the script. The file is
// overwritten on each run; override the path with LOG_FILE=/path/to/file.
//
// We use a *synchronous* fd (openSync + writeSync) rather than an async
// createWriteStream so that nothing is lost when the process exits abruptly
// (e.g. an uncaught exception from a failed remote command, which Node prints
// and then exits without flushing async streams — that truncated the log
// before this fix). Sync writes are flushed by the time write() returns.
import { openSync, writeSync, closeSync } from 'node:fs';

// --prepare gets its own log: it is meant to run while a deploy may still be
// running, and reopening that deploy's log with 'w' would truncate it under it.
// (Checked on raw argv/env because the yargs config is parsed further below.)
const IS_PREPARE_RUN = process.argv.includes('--prepare') || (process.env.PREPARE || '').toLowerCase() === 'true';
// --mtproxy-only is append-only and may be run while the previous deploy log is
// still useful; give it a separate file so it never truncates that log.
const IS_MTPROXY_ONLY_RUN = process.argv.includes('--mtproxy-only') || (process.env.MTPROXY_ONLY || '').toLowerCase() === 'true';
const LOG_FILE = process.env.LOG_FILE
  || resolve(__dirname, IS_PREPARE_RUN ? 'deploy-remote-docker.prepare.log'
    : IS_MTPROXY_ONLY_RUN ? 'deploy-remote-docker.mtproxy-only.log'
    : 'deploy-remote-docker.log');
const logFd = openSync(LOG_FILE, 'w');

// Strip ANSI color/escape sequences so the file stays readable in plain text.
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');

// The log file should mirror what the TERMINAL shows, not every intermediate
// write. Progress meters redraw a single line using carriage returns ('\r ...'
// with no newline). On screen these overwrite in place — one animated line — but
// a naive tee would append every redraw, bloating the log with hundreds of
// partial lines. So we maintain a tiny line buffer: a *bare* '\r' (progress
// redraw) resets the current line, and we only commit a line to the log when a
// '\n' terminates it. The net effect: the log contains exactly the final state
// of each line, matching the terminal's last frame.
//
// IMPORTANT: '\r\n' is a single line terminator, NOT a redraw. Remote output
// (e.g. `docker logs` of the bot) frequently arrives CRLF-terminated; a naive
// "'\r' clears the line" rule would erase the text of every such line and emit
// a blank one. So we only treat '\r' as a redraw when it is NOT immediately
// followed by '\n'. We also carry a one-char pending state across chunk
// boundaries, since a line's '\r' and its '\n' can land in separate writes.
let logLineBuf = '';
let pendingCR = false; // last char of previous chunk was '\r' (decision deferred)
const commitLine = () => { try { writeSync(logFd, logLineBuf + '\n'); } catch {} logLineBuf = ''; };
const teeToLog = (text) => {
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (pendingCR) {
      // Resolve the carried '\r' now that we can see what follows it.
      pendingCR = false;
      if (ch === '\n') { commitLine(); continue; } // '\r\n' => commit the line
      logLineBuf = '';                             // bare '\r' => redraw: discard
    }                                              // the frame, keep parsing ch.
    if (ch === '\r') {
      if (i + 1 < text.length) {
        if (text[i + 1] === '\n') { commitLine(); i++; } // '\r\n' => commit line
        else { logLineBuf = ''; }                        // bare '\r' => discard
      } else { pendingCR = true; }                       // decide on next chunk
    } else if (ch === '\n') { commitLine(); }
    else { logLineBuf += ch; }
  }
};
for (const stream of [process.stdout, process.stderr]) {
  const originalWrite = stream.write.bind(stream);
  stream.write = (chunk, encoding, callback) => {
    try {
      teeToLog(stripAnsi(typeof chunk === 'string' ? chunk : chunk.toString()));
    } catch { /* never let logging break the deploy */ }
    return originalWrite(chunk, encoding, callback);
  };
}

// Always print the log path as the very last line, on success or failure, so
// the user can find the full log no matter how the run ends. process.on('exit')
// fires synchronously for every termination path (normal return, process.exit,
// or an uncaught exception after the default handler prints it).
let exitNoticePrinted = false;
const printLogNotice = () => {
  if (exitNoticePrinted) return;
  exitNoticePrinted = true;
  // Flush any un-terminated line still in the tee buffer (a trailing pending
  // '\r' resolves to a normal line end here).
  try { if (logLineBuf || pendingCR) { writeSync(logFd, logLineBuf + '\n'); logLineBuf = ''; pendingCR = false; } } catch {}
  // Write directly so this survives even if stdout was already torn down.
  try { writeSync(logFd, `>>> Full log written to ${LOG_FILE}\n`); } catch {}
  try { writeSync(1, `>>> Full log written to ${LOG_FILE}\n`); } catch {}
  try { closeSync(logFd); } catch {}
};
process.on('exit', printLogNotice);

// Print errors ourselves instead of letting Node's default handler do it.
// The default handler runs the error through util.inspect, which TRUNCATES
// long strings ("...3913 more characters") — and a failed remote deploy
// carries its entire stdout/stderr on err.stdout/err.stderr, which is exactly
// the full remote log the user needs. We print those verbatim, then exit(1)
// so process.on('exit') still fires and the log path lands as the last line.
// The main flow is wrapped in try/catch (see bottom of file) and routes here.
const fatal = (label, err) => {
  console.error(`\n>>> ${label}`);
  if (err && (err.stdout || err.stderr)) {
    if (err.stdout) console.error(`\n--- remote stdout ---\n${err.stdout}`);
    if (err.stderr) console.error(`\n--- remote stderr ---\n${err.stderr}`);
    console.error(`\n>>> ${err.message || err}`);
  } else {
    console.error(err?.stack || err?.message || String(err));
  }
  process.exit(1);
};

console.log(`>>> Logging full output to ${LOG_FILE}`);

const LENV_EXAMPLE_TEMPLATE = `# Server
SERVER_IP: 0.0.0.0
SERVER_USER: root
SERVER_PASS:

# Queue: minimum gap the bot enforces between STARTING successive tasks (per tool),
# in milliseconds. This is the "interval between tasks". 300000 = 5 minutes.
# hive-mind env var: HIVE_MIND_MIN_START_INTERVAL_MS (default 600000 = 10 min).
HIVE_MIND_MIN_START_INTERVAL_MS: 300000

# Safety floor for the interval above. hive-mind resolves the effective gap as
# Math.max(MIN_START_INTERVAL_MS, FLOOR_MS), and FLOOR_MS defaults to 10 min —
# so WITHOUT this key the 5 min above is silently clamped back up to 10 min
# (hive-mind#2053, fixed in 2.5.5 by adding this opt-out). Keep it equal to the
# interval above; raising the interval past this floor works without touching it.
HIVE_MIND_MIN_START_INTERVAL_FLOOR_MS: 300000

# Queue admission gate: block/enqueue new tasks when disk usage reaches this RATIO
# (float 0.0-1.0, NOT a percent — 0.65 = 65%). hive-mind default is 0.8; lower it
# to leave more headroom before the host disk fills up. Uncomment to override.
# HIVE_MIND_DISK_THRESHOLD: 0.65

# Telegram Bot
HIVE_TELEGRAM_BOT_CONFIGURATION: "
TELEGRAM_BOT_TOKEN: YOUR_TELEGRAM_BOT_TOKEN
TELEGRAM_ALLOWED_CHATS:
  -1002975819706
  -1002861722681
TELEGRAM_HIVE_OVERRIDES:
  --all-issues
  --once
  --skip-issues-with-prs
  --attach-logs
  --verbose
  --no-tool-check
  --disable-report-issue
  (--isolation docker)
TELEGRAM_SOLVE_OVERRIDES:
  --attach-logs
  --verbose
  --no-tool-check
  --disable-report-issue
  (--isolation docker)
TELEGRAM_BOT_VERBOSE: true
"

# Telegram MTProto proxy (optional). The default engine is the official classic
# mtproto-proxy image, the only one verified end-to-end for messages, photos,
# video and large documents. mtg is available for experiments only.
# Enable with --mtproxy on the command line or DEPLOY_MTPROXY: true here.
DEPLOY_MTPROXY: false
MTPROXY_ENGINE: classic
MTPROXY_PORT: 443
# TCP MSS clamp applied to the proxy port(s) in both directions. 1360 was too
# high on the mobile path; 1200 is the known-good value. Persisted via
# mtproxy-mss.service and re-applied on reboot.
MTPROXY_MSS: 1200
# Classic engine image (official mtproto-proxy; reads the persisted secret).
MTPROXY_CLASSIC_IMAGE: mtproxy/mtproxy:latest
# mtg-only settings (ignored by the classic engine):
# MTPROXY_FRONTING_HOST: contabo.com
# MTPROXY_IMAGE: nineseconds/mtg:2.3.0
# Pin the secret (32-char hex key; an mtg ee... secret is also accepted and its
# key is reused). Leave unset to reuse the persisted key, or generate one.
# The tg:// link is written root-only to the engine's config dir /link.txt.
# MTPROXY_SECRET: 00baadf00d15abad1deaa515baadcafe`;

const currentExample = existsSync(LENV_EXAMPLE_PATH) ? readFileSync(LENV_EXAMPLE_PATH, 'utf8') : null;
if (currentExample !== LENV_EXAMPLE_TEMPLATE) {
  writeFileSync(LENV_EXAMPLE_PATH, LENV_EXAMPLE_TEMPLATE);
  console.log(currentExample === null
    ? `>>> Wrote ${LENV_EXAMPLE_PATH} (template for .lenv)`
    : `>>> Updated ${LENV_EXAMPLE_PATH} to match the embedded template`);
}

if (!existsSync(LENV_PATH)) {
  console.error('>>> ERROR: .lenv not found at', LENV_PATH);
  console.error('>>>   Copy the template and fill in your server credentials:');
  console.error(`>>>     cp ${LENV_EXAMPLE_PATH} ${LENV_PATH}`);
  console.error('>>>   Required values: SERVER_IP, SERVER_USER, SERVER_PASS');
  console.error('>>>   Then re-run this script.');
  process.exit(1);
}

// Load configuration from .lenv (makeConfig for single values + CLI args)
const config = makeConfig({
  yargs: ({ yargs, getenv }) =>
    yargs
      .version(false)
      .help(false)
      .option('server-ip', { default: getenv('SERVER_IP') })
      .option('server-user', { default: getenv('SERVER_USER') })
      .option('server-pass', { default: getenv('SERVER_PASS') })
      .option('image-variant', {
        choices: ['dind', 'plain'],
        // Default is 'dind' (konard/hive-mind-dind:1.74.3+ on box-dind 2.1.4+);
        // box#88 / hive-mind#1850 shipped, so dind is fully supported.
        default: getenv('HIVE_MIND_IMAGE_VARIANT') || 'dind',
        description: 'Image flavor forwarded to deploy-docker.mjs ("dind" default, or "plain")',
      })
      .option('image', {
        type: 'string',
        default: getenv('HIVE_MIND_IMAGE') || '',
        description: 'Override image reference forwarded to deploy-docker.mjs',
      })
      .option('isolation-mode', {
        choices: ['dood', 'dind'],
        // Forwarded to deploy-docker.mjs. Default "dood" (Docker-outside-of-Docker):
        // isolated tasks run on the host daemon, reusing the host image with zero
        // copy / zero extra disk. "dind" uses a nested daemon seeded by passthrough
        // (duplicates the multi-GB image). Only affects the dind image variant.
        default: getenv('HIVE_MIND_ISOLATION_MODE') || 'dood',
        description: 'Docker isolation mode forwarded to deploy-docker.mjs ("dood" default, no-copy; or "dind", nested+copy)',
      })
      .option('reset-docker', {
        type: 'boolean',
        default: false,
        description: 'DANGEROUS: forwarded to deploy-docker.mjs to nuke ALL Docker state (containers, images, volumes, networks, build cache) on the remote host before deploying.',
      })
      .option('keep-inactive-variant', {
        type: 'boolean',
        default: false,
        description: 'Forward to deploy-docker.mjs: skip removing the other hive-mind variant\'s images. By default the script removes the inactive variant to free disk.',
      })
      .option('interactive-login', {
        type: 'boolean',
        default: false,
        description: 'Forward to deploy-docker.mjs: if a tool (claude/codex/gh) is unauthenticated, drop into an interactive login (prints the auth URL, pauses for the code) instead of just warning. This script already runs the remote deploy over `ssh -tt`, so the TTY reaches the container. Off by default (unauthenticated tools are a soft warning; deploy still completes).',
      })
      .option('mtproxy', {
        type: 'boolean',
        // Forwarded to deploy-docker.mjs. The proxy's image/port/secret/workers
        // are read by the remote script from the copied .lenv (MTPROXY_*), so a
        // secret is never passed through a command line that lands in the log.
        default: (getenv('DEPLOY_MTPROXY') || '').toLowerCase() === 'true',
        description: 'Also deploy/update the Telegram MTProto proxy alongside hive-mind. Default engine: classic mtproto-proxy (known-good for messages and media). Configure MTPROXY_PORT/MTPROXY_SECRET in .lenv. Off by default.',
      })
      .option('mtproxy-only', {
        type: 'boolean',
        // SAFE APPEND-ONLY MODE. This is the "add the proxy to a box that is
        // already running hive-mind" path. It deliberately skips EVERYTHING the
        // normal deploy does to the host: no pre-deploy reboot, no swap/BBR or
        // apt/docker/node provisioning, no AI-data backup or bucket cleanup, no
        // deploy-script overwrite, no orphan killing, and no hive-mind teardown.
        // An already-running mtproxy is left untouched (idempotent no-op).
        default: (getenv('MTPROXY_ONLY') || '').toLowerCase() === 'true',
        description: 'SAFE APPEND-ONLY: install/start ONLY the MTProto proxy on an already-deployed server. No reboot, no backups/cleanup, no Docker/Node install, no hive-mind restart, and no changes to an already-running mtproxy. Implies --mtproxy.',
      })
      .option('mtproxy-update', {
        type: 'boolean',
        default: (getenv('MTPROXY_UPDATE') || '').toLowerCase() === 'true',
        description: 'Recreate ONLY the mtproxy container to apply a new image/config. Safe with --mtproxy-only; hive-mind is never touched.',
      })
      .option('mtproxy-engine', {
        choices: ['classic', 'mtg'],
        default: getenv('MTPROXY_ENGINE') || 'classic',
        description: 'Proxy engine forwarded to deploy-docker.mjs: "classic" (default, known-good) or "mtg" (FakeTLS experiment).',
      })
      .option('verify-mtproxy', {
        type: 'boolean',
        default: (getenv('VERIFY_MTPROXY') || '').toLowerCase() === 'true',
        description: 'After deploying/leaving mtproxy, verify the selected engine (classic: port/MSS/DC reachability; mtg: mtg doctor) and fail on critical failures.',
      })
      .option('mtproxy-port', {
        type: 'string',
        default: getenv('MTPROXY_PORT') || '443',
        description: 'Host port forwarded to deploy-docker.mjs; also selects the classic container name (mtproxy-classic-<port>).',
      })
      .option('mtproxy-mss', {
        type: 'string',
        default: getenv('MTPROXY_MSS') || '1200',
        description: 'TCP MSS clamp forwarded to deploy-docker.mjs (default 1200).',
      })
      .option('mtproxy-classic-image', {
        type: 'string',
        default: getenv('MTPROXY_CLASSIC_IMAGE') || '',
        description: 'Classic proxy image override forwarded to deploy-docker.mjs (default mtproxy/mtproxy:latest).',
      })
      .option('mtproxy-image', {
        type: 'string',
        default: getenv('MTPROXY_IMAGE') || '',
        description: 'mtg-compatible image override forwarded to deploy-docker.mjs (only with --mtproxy-engine mtg; default nineseconds/mtg:2.3.0)',
      })
      .option('mtproxy-fronting-host', {
        type: 'string',
        default: getenv('MTPROXY_FRONTING_HOST') || '',
        description: 'FakeTLS/domain-fronting hostname forwarded to deploy-docker.mjs (default contabo.com)',
      })
      .option('verify-reboot', {
        type: 'boolean',
        default: false,
        description: 'EXTRA post-deploy reboot. The deploy ALWAYS reboots the box BEFORE installing (proving ssh/swap/docker survive a restart on every run). This flag adds a SECOND reboot AFTER the deploy to additionally prove the hive-mind bot CONTAINER auto-restarts (restart policy unless-stopped) — the one thing the pre-deploy reboot cannot check because the container does not exist yet. Off by default (adds a reboot + several minutes).',
      })
      .option('force-unready', {
        type: 'boolean',
        default: false,
        description: 'Skip the HARD readiness gate that blocks the deploy until the server is fully provisioned (cloud-init finished, apt/dpkg idle, swap active, enough disk). By default a not-ready box aborts BEFORE any install/backup so a half-reinstalled VPS is never provisioned into a broken state. Use only if the gate is falsely blocking a known-good box.',
      })
      .option('backup-mode', {
        choices: ['pigz', 'zstd', 'rsync'],
        // How to back up the claude/codex AI session data:
        //   rsync (DEFAULT) - NO compression. rsync a persistent local mirror
        //                     (data/backups/mirror/), transferring only changed
        //                     files at max throughput. Fastest on repeat runs and
        //                     RESUMABLE (--partial --inplace): a dropped connection
        //                     picks up where it left off instead of re-downloading
        //                     a multi-GB archive from scratch. This is why it is
        //                     the default — the link to this server is flaky and the
        //                     one-shot archive modes lose the whole transfer on a
        //                     mid-download disconnect.
        //   pigz            - parallel gzip on server, then download one archive.
        //                     Balanced compression; NOT resumable (one-shot).
        //   zstd            - parallel zstd -19 on server, then download. Smallest
        //                     archive => least bytes over the slow link; best when
        //                     transfer is the bottleneck. NOT resumable (one-shot).
        default: (getenv('BACKUP_MODE') || 'rsync').toLowerCase(),
        description: 'AI-data backup method: "rsync" (default, resumable no-zip persistent mirror, deltas only), "pigz" (parallel gzip+download), or "zstd" (smaller archive+download)',
      })
      .option('skip-backup', {
        type: 'boolean',
        // Entirely skip the AI session-data backup step. Useful on a slow/metered
        // link where downloading multi-GB session data is impractical. NOTE: this
        // forces --cleanup-ai-data OFF — we never delete server data we didn't back up.
        default: (getenv('SKIP_BACKUP') || '').toLowerCase() === 'true',
        description: 'Skip the AI session-data backup entirely (e.g. on a slow/metered connection). Implies no server-side cleanup.',
      })
      .option('backup-only', {
        type: 'boolean',
        // Run ONLY the AI session-data backup, then exit BEFORE any deploy step
        // (no Node install, no file copy, no deploy-docker.mjs run). The point is
        // to PRE-SYNC everything ahead of time: with the default rsync mode this
        // populates the persistent local mirror (data/backups/mirror/) so that a
        // later real deploy's backup step transfers only the small delta and the
        // redeploy is fast. Run this repeatedly in advance; the actual redeploy
        // then has almost nothing left to download. NOTE: server-side cleanup
        // (--cleanup-ai-data) is honored just like a normal deploy — it runs only
        // after a verified-OK backup — so backup-only can also prune the server.
        default: (getenv('BACKUP_ONLY') || '').toLowerCase() === 'true',
        description: 'Only run the AI session-data backup (pre-sync the rsync mirror) and exit before deploying. Use to presync in advance so the real redeploy is fast.',
      })
      .option('prepare', {
        type: 'boolean',
        // NON-DESTRUCTIVE preparation for a later real deploy. Does every slow,
        // download-heavy part ahead of time while the current deployment keeps
        // running untouched:
        //   • syncs the AI sessions into the rsync mirror (same as --backup-only),
        //   • pre-pulls the hive-mind image on the server (the running container
        //     keeps its own image; the real deploy's pull then says "up to date").
        // It never reboots, never provisions swap, never stops/removes a container,
        // never empties server buckets (cleanup is shown as a dry run), and only
        // LISTS leftover temp archives instead of deleting them (a concurrently
        // running deploy may still be writing one). Run it as often as you like;
        // the real deploy afterwards only transfers what changed since.
        default: (getenv('PREPARE') || '').toLowerCase() === 'true',
        description: 'Non-destructive preparation: sync AI sessions into the local mirror and pre-pull the image on the server, without reboot, cleanup or touching the running deployment, so the following real deploy is fast.',
      })
      .option('rsync-compress', {
        choices: ['zstd', 'off'],
        // Stream compression inside the rsync protocol (no archive files are
        // created). Session JSONL measured 6.1x smaller with zstd -3 (claude) and
        // 3.6x (codex) on 2026-10-23, and the link to the server is the bottleneck
        // (~35 KB/s with packet loss), so compressing is far faster than not.
        default: (getenv('RSYNC_COMPRESS') || 'zstd').toLowerCase(),
        description: 'rsync stream compression for the AI-session mirror: "zstd" (default) or "off".',
      })
      .option('tcp-bbr', {
        type: 'boolean',
        // The server is the SENDER of the mirror rsync, so its congestion control
        // decides the speed. With loss-based cubic, ~3% packet loss on a ~300 ms
        // path caps one TCP stream at ~35 KB/s (Mathis: MSS/RTT * 1.22/sqrt(loss)).
        // BBR is not loss-based and keeps the window open on such paths.
        default: (getenv('TCP_BBR') || 'true').toLowerCase() !== 'false',
        description: 'Enable BBR TCP congestion control on the server (persistent, applies to new connections) so transfers to/from it are not throttled by packet loss. Default on; --no-tcp-bbr to skip.',
      })
      .option('cleanup-ai-data', {
        choices: ['off', 'dry-run', 'run'],
        // Tri-state (was a boolean). After a verified-OK local backup, reclaim
        // server disk by EMPTYING the three big AI-data buckets — NOT the whole
        // claude/codex dirs. The buckets are the only large, purely-historical
        // data; config/auth/plugins/skills/live-state DBs are left untouched so
        // the bot keeps running:
        //   codex/sessions           (rollout transcripts — the 8.6 GB bulk)
        //   codex/generated_images   (per-session PNGs — ~1.8 GB)
        //   claude/projects          (per-run project dirs — ~2.3 GB)
        // Plus a conservative reset of the ONE coupled index that would otherwise
        // dangle: codex/history.jsonl (indexes sessions by session_id).
        //   run      (DEFAULT) — actually empty the buckets, but ONLY after both
        //                        the whole-backup verify AND a per-bucket check
        //                        that the mirror already contains that bucket.
        //   dry-run            — show exactly what WOULD be emptied (per-bucket
        //                        size + the mirror-⊇-bucket safety check) and
        //                        delete NOTHING. Safe to run anytime, even with a
        //                        task executing on the server.
        //   off                — back up only; delete nothing on the server.
        // DEFAULT is 'run': a deploy always backs up AND reclaims server disk. The
        // three-way safety net still holds — nothing is deleted unless the whole
        // backup verified AND that bucket's mirror copy ⊇ the server AND the target
        // path passes the hard path guard; auth/config/state DBs are never targets.
        // Set the env var to override: CLEANUP_AI_DATA=off (or dry-run) turns it
        // down; legacy true→run / false→off still accepted. --skip-backup forces off.
        default: (() => {
          const v = (getenv('CLEANUP_AI_DATA') || '').toLowerCase();
          if (v === 'off' || v === 'false') return 'off';
          if (v === 'dry-run') return 'dry-run';
          if (v === 'run' || v === 'true') return 'run';
          return 'run'; // unset ⇒ default ON
        })(),
        description: 'Server-side bucket cleanup after a verified backup: "run" (DEFAULT) empties codex/{sessions,generated_images} + claude/projects (+resets codex/history.jsonl); "dry-run" shows what would be emptied and deletes nothing; "off" backs up only. Per-bucket "mirror ⊇ bucket" check + hard path guard gate every real delete; skipped entirely if the backup fails. Override via CLEANUP_AI_DATA=off|dry-run|run.',
      })
      .option('clean-temp-archives', {
        choices: ['off', 'run', 'dry-run'],
        // Sweep orphaned /tmp/ai-sessions-backup-*.{tar.gz,tar.zst} archives left
        // behind on the server by a deploy that died mid-backup (before its own
        // rm could run). 'off' (default) = also sweep at the start of a normal
        // deploy, then proceed. 'run' = ONLY sweep and exit (clean now, no deploy).
        // 'dry-run' = ONLY list what WOULD be swept and exit (test the logic).
        // NOTE: a normal deploy ALWAYS sweeps at startup regardless of this flag;
        // the flag's non-'off' values turn the script into a standalone cleaner.
        default: 'off',
        description: 'Standalone temp-archive cleanup: "run" sweeps orphaned /tmp backup archives and exits; "dry-run" lists them and exits; "off" (default) does a normal deploy (which still sweeps at startup)',
      })
      .option('verbose', { type: 'boolean', default: false, description: 'Enable verbose debug output' })
      .option('dangerously-show-secrets', { type: 'boolean', default: false, description: 'Show secret values in debug output' }),
});

const VERBOSE = config.verbose;
const SHOW_SECRETS = config.dangerouslyShowSecrets;
const MTPROXY_ONLY = config.mtproxyOnly === true;
if (MTPROXY_ONLY) config.mtproxy = true;
const MTPROXY_ENGINE = String(config.mtproxyEngine || 'classic').toLowerCase();
const MTPROXY_PORT = String(config.mtproxyPort || '443').trim();
const MTPROXY_CONTAINER = MTPROXY_ENGINE === 'classic' ? `mtproxy-classic-${MTPROXY_PORT}` : 'mtproxy';
const MTPROXY_CONFIG_DIR = MTPROXY_ENGINE === 'classic' ? `/root/.hive-mtproxy-classic-${MTPROXY_PORT}` : '/root/.hive-mtproxy';
const MTPROXY_LINK_PATH = `${MTPROXY_CONFIG_DIR}/link.txt`;

const mask = (value) => SHOW_SECRETS ? value : '***';
const log = (...args) => { if (VERBOSE) console.log('[DEBUG]', ...args); };

const IP = config.serverIp;
const USER = config.serverUser;
const PASS = config.serverPass;

// Validate required config
const missing = [];
if (!IP) missing.push('SERVER_IP');
if (!USER) missing.push('SERVER_USER');
if (!PASS) missing.push('SERVER_PASS');
if (missing.length) {
  console.error(`>>> ERROR: Missing required .lenv values: ${missing.join(', ')}`);
  process.exit(1);
}

// ServerAliveInterval+CountMax keep the long-running remote node process from
// dropping the SSH session mid-deploy (the previous run logged "Deploy
// complete" while the remote was still waiting for dockerd — that was an
// upstream NAT/firewall idle timeout, not a script-success).
// TCPKeepAlive defends against intermediate proxies that ignore SSH-level
// pings but honor TCP keepalives.
const SSH_OPTS = '-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=10 -o ServerAliveInterval=30 -o ServerAliveCountMax=120 -o TCPKeepAlive=yes -o LogLevel=ERROR -o PubkeyAuthentication=no -o PreferredAuthentications=password,keyboard-interactive';

// sshpass exit 5 = password rejected: the remote command never ran, so a retry is
// always safe. Observed 2026-10-07: sshd logged "Failed password" for the CORRECT
// password from our IP on isolated connections (Step 4 twice, one Step-5 probe)
// while the box was under a root brute-force flood; the next connection succeeded.
const SSH_AUTH_ATTEMPTS = 4;
// OpenSSH can also return 255 for an authentication rejection. Match its
// complete, pre-command stderr transcript and require empty stdout. A generic
// exit 255 (disconnect, timeout, or remote exit) must never replay a command.
const isSshAuthenticationReject = (result) => result?.code === 5 || (
  result?.code === 255 && !(result.stdout || '').trim()
  && /^(?:Permission denied, please try again\.\r?\n)*[^\s]+@[^\s]+: Permission denied \((?:publickey|password|keyboard-interactive)(?:,(?:publickey|password|keyboard-interactive))*\)\.\s*$/.test((result.stderr || '').trim())
);
const retryOnAuthReject = async (runOnce, what) => {
  for (let attempt = 1; ; attempt++) {
    const result = await runOnce();
    if (!isSshAuthenticationReject(result) || attempt >= SSH_AUTH_ATTEMPTS) return result;
    console.log(`   ⚠️  SSH authentication rejected (exit ${result.code}) on attempt ${attempt}/${SSH_AUTH_ATTEMPTS} — ${what} did not run; retrying in ${attempt * 2}s`);
    await new Promise((r) => setTimeout(r, attempt * 2000));
  }
};

// Helper function to sleep
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Helper to run SSH commands and print reproducible command.
// command-stream's $ does NOT throw on non-zero exit by default — it returns
// a result with code != 0. We treat anything non-zero as a failure unless
// the caller passed ignoreErrors, so a failing remote command (e.g. the
// inner deploy-docker.mjs hitting process.exit(1)) propagates out and the
// wrapper does NOT falsely print "Deploy complete".
const ssh = async (command, { silent = false, ignoreErrors = false } = {}) => {
  if (!silent) {
    console.log(`>>> sshpass -p '${mask(PASS)}' ssh ${SSH_OPTS} ${USER}@${IP} ${command}`);
  }
  try {
    // When silent, also suppress command-stream's default stdout mirroring —
    // otherwise the raw output of probe commands (du byte counts, `echo yes`,
    // `command -v` lines, stat sizes) leaks to the terminal/log as noise even
    // though the caller only wants result.stdout. The non-silent path keeps
    // mirroring so real remote command output streams live.
    const run = silent ? $({ mirror: false }) : $;
    const result = await retryOnAuthReject(() => run`sshpass -p ${PASS} ssh ${SSH_OPTS.split(' ')} ${USER}@${IP} ${command}`, 'command');
    log(`Exit code: ${result.code}`);
    if (result.code !== 0 && !ignoreErrors) {
      const err = new Error(`Remote SSH command failed (exit ${result.code}): ${command}`);
      err.code = result.code;
      err.stdout = result.stdout;
      err.stderr = result.stderr;
      throw err;
    }
    return result;
  } catch (error) {
    log(`Command failed (code ${error.code}):`, error.message || error);
    if (!ignoreErrors) throw error;
  }
};

// Like ssh(), but allocates a pseudo-TTY (-tt). Use this for the ONE long-lived
// remote command (the deploy) whose lifetime must be bound to this ssh session:
// with a TTY, sshd sends SIGHUP to the remote process group when the client
// disconnects, so an interrupted local run does not leave an orphaned remote
// deploy behind. A TTY merges stdout+stderr into one stream and can inject CR
// translation; that is fine here because we only need the live log, not
// separated streams. Errors propagate exactly like ssh().
const sshTTY = async (command, { ignoreErrors = false } = {}) => {
  console.log(`>>> sshpass -p '${mask(PASS)}' ssh -tt ${SSH_OPTS} ${USER}@${IP} ${command}`);
  try {
    const result = await retryOnAuthReject(() => $`sshpass -p ${PASS} ssh -tt ${SSH_OPTS.split(' ')} ${USER}@${IP} ${command}`, 'remote deploy');
    log(`Exit code: ${result.code}`);
    if (result.code !== 0 && !ignoreErrors) {
      const err = new Error(`Remote SSH command failed (exit ${result.code}): ${command}`);
      err.code = result.code;
      err.stdout = result.stdout;
      err.stderr = result.stderr;
      throw err;
    }
    return result;
  } catch (error) {
    log(`Command failed (code ${error.code}):`, error.message || error);
    if (!ignoreErrors) throw error;
  }
};

// Helper to run SCP commands
const scp = async (localPath, remotePath) => {
  console.log(`>>> sshpass -p '${mask(PASS)}' scp ${SSH_OPTS} ${localPath} ${USER}@${IP}:${remotePath}`);
  await retryOnAuthReject(() => $`sshpass -p ${PASS} scp ${SSH_OPTS.split(' ')} ${localPath} ${USER}@${IP}:${remotePath}`, 'copy');
};

// Run an apt-get command robustly on a freshly-provisioned box. Two hazards we
// have actually hit on a fresh Contabo Ubuntu 24.04:
//   1. dpkg/apt lock still held by cloud-init or unattended-upgrades for the
//      first few minutes after boot — a plain `apt-get install` then aborts.
//   2. A package config prompt blocking on the non-TTY SSH channel.
// So: wait (bounded) for the frontend lock to clear, then run non-interactively.
// `aptCmd` is the apt-get subcommand+args, e.g. 'install -y docker-ce ...'.
const apt = (aptCmd, opts = {}) => {
  // Build the remote bash script, then base64-encode it so NONE of its shell
  // metacharacters — `$(seq 1 60)`, `($i)`, the double quotes — have to survive the
  // command-stream `$` template + the remote login shell. Previously this used
  // `bash -c '<script>'` inline, and the nested single quotes collided with the
  // template's quoting, producing `/bin/sh: syntax error near unexpected token (`.
  // base64 (only [A-Za-z0-9+/=]) is quote-safe by construction — same technique as
  // the swap script.
  const script =
    'for i in $(seq 1 60); do ' +
    'fuser /var/lib/dpkg/lock-frontend >/dev/null 2>&1 || fuser /var/lib/apt/lists/lock >/dev/null 2>&1 || break; ' +
    'echo "   waiting for apt/dpkg lock ($i)"; sleep 5; done; ' +
    `DEBIAN_FRONTEND=noninteractive apt-get ${aptCmd}`;
  const b64 = Buffer.from(script, 'utf8').toString('base64');
  return ssh(`echo ${b64} | base64 -d | bash`, opts);
};

// Read total active swap in MB from /proc/meminfo (SwapTotal, in kB). The kernel
// populates this immediately on swapon — unlike `free`, whose column output can
// briefly lag right after activation and is more fragile to parse. Returns 0 if
// unreadable. Used to CONFIRM the swap step and the post-reboot durability check.
// IMPORTANT: remote commands run through the ssh() helper are interpolated into a
// command-stream `$` template, which EATS `$N` tokens (it treats `$4`, `$2`… as
// shell positional/var expansions and strips them). So we must NEVER rely on awk
// field refs like `{print $4}` in a remote command — awk would see `int(/1024)`
// and print 0, producing a FALSE "0 GB / 0 MB" reading (this exact bug false-failed
// the disk gate on a 185 GB-free box). All probes below avoid `$N` entirely.

// Active swap in MB from /proc/meminfo SwapTotal (kB). `grep | tr -dc 0-9` — no awk.
const activeSwapMb = async () => {
  // null = probe failed (SSH error) — never report a failed read as "0 MB swap".
  const r = await ssh("grep '^SwapTotal:' /proc/meminfo | tr -dc '0-9'", { silent: true, ignoreErrors: true });
  const kb = parseInt((r?.stdout || '').trim(), 10);
  if (r?.code !== 0 || Number.isNaN(kb)) return null;
  return Math.floor(kb / 1024);
};

// Best-effort RESTORE of swap that is provisioned (fstab entry + /swapfile exist)
// but not currently ACTIVE. This is the fix for the false "0 MB swap" abort seen
// on 2026-07-12: the swap step confirmed 4095 MB, then the readiness gate 4s later
// read 0 MB — swap had momentarily gone inactive (a fresh boot where the fstab
// swap had not been swapon'd yet, or a transient probe blip). Rather than abort a
// box whose swap is fully configured, re-activate it from fstab and, if the file
// exists but isn't a valid swap area, rebuild the header, then swapon it. Returns
// the active swap MB after the attempt. Idempotent and safe: if swap is already
// active, `swapon -a` is a no-op ("swapon: /swapfile: already active") and we just
// re-read. Never throws — every remote step is ignoreErrors and the caller decides.
const restoreSwapMb = async () => {
  // `swapon -a` activates everything in /etc/fstab. If /swapfile exists but its
  // header is missing/corrupt (swapon -a would skip it), rebuild + swapon it
  // directly. `swapon --show=size --noheadings --bytes` avoids awk `$N`.
  const restoreScript = [
    'SWAPFILE=/swapfile',
    'swapon -a 2>/dev/null || true',
    // If still no active swap and our swapfile exists, (re)make and activate it.
    'if [ "$(swapon --show=name --noheadings | wc -l)" -eq 0 ] && [ -f "$SWAPFILE" ]; then',
    '  chmod 600 "$SWAPFILE";',
    '  swapon "$SWAPFILE" 2>/dev/null || { mkswap "$SWAPFILE" >/dev/null 2>&1 && swapon "$SWAPFILE"; } || true;',
    'fi',
  ].join('\n');
  const b64 = Buffer.from(restoreScript, 'utf8').toString('base64');
  await ssh(`echo ${b64} | base64 -d | bash`, { silent: true, ignoreErrors: true });
  return activeSwapMb();
};

// Disk on / in MB — `df -BM --output=<field>` gives a single clean column, so no
// awk `$N` is needed. `size` = capacity, `avail` = free. MB precision matters for
// the gate: comparing whole GB with Math.floor would false-fail a box marketed as
// "51 GB" whose df size lands at e.g. 52100M (floor → 50 GB → "< 51 GB").
const diskMbOnRoot = async (field /* 'size' | 'avail' */) => {
  // null = probe failed (SSH error). 2026-10-07: a rejected login made the gate
  // print "free on / right now: 0 GB" on a box with 136 GB free.
  const r = await ssh(`df -BM --output=${field} / | tail -1 | tr -dc '0-9'`, { silent: true, ignoreErrors: true });
  const mb = parseInt((r?.stdout || '').trim(), 10);
  return (r?.code !== 0 || Number.isNaN(mb)) ? null : mb;
};
const freeGbOnRoot = async () => { const mb = await diskMbOnRoot('avail'); return mb == null ? null : Math.floor(mb / 1024); };
// "4095 MB" / "unknown (probe failed)" for log lines.
const fmtMb = (mb) => (mb == null ? 'unknown (probe failed)' : `${mb} MB`);

// Docker daemon responding right now?
const dockerDaemonUp = async () =>
  (await ssh('docker info -f "{{.ServerVersion}}"', { silent: true, ignoreErrors: true }))?.code === 0;

// Constants shared by the readiness gate(s).
// The HARD disk requirement is on TOTAL capacity, NOT free space — the deploy
// cleans up (removes old images/containers) BEFORE it pulls, so a box can be near
// 0 free right now yet still deploy fine once cleaned. What we truly cannot work
// around is a disk that is too SMALL overall. Minimum total =
//   image (~33 GB) + working room (20 GB) + swap (4 GB) = 57 GB.
const IMAGE_SIZE_GB = 33;   // konard/hive-mind-dind footprint on disk (2.34.0: 32.7 GB per `docker images`)
const WORKING_GB = 20;      // build/commit/temp headroom during the deploy
const SWAP_GB = 4;          // the /swapfile we provision
const REQUIRED_TOTAL_GB = IMAGE_SIZE_GB + WORKING_GB + SWAP_GB; // = 57 GB
const MIN_READY_SWAP_MB = 3500; // ≥4 GB target with header/rounding slack

// Run the FULL readiness gate: re-probe disk, swap, and SSH-stability LIVE, merge
// any pre-recorded checks (`extra`), print a summary, and BLOCK (exit 1) if the box
// is not ready — unless --force-unready downgrades it to a warning. `requireDocker`
// additionally asserts the Docker daemon is up (used post-reboot to prove docker
// survived the restart). Returns nothing; aborts on failure. Reused before AND
// after the mandatory reboot so we install only onto a clean, verified box.
const assertReadyGate = async ({ label, extra = [], requireDocker = false }) => {
  nextStep(label);
  const checks = [...extra];
  const push = (name, passed, detail) => checks.push({ name, passed: !!passed, detail: detail || '' });

  // HARD gate on TOTAL disk (see above). Free space is only reported for context —
  // it is expected to be low before the deploy's own cleanup runs, so it must NOT
  // block. If total is too small, we genuinely cannot deploy at all.
  // Compare in MB with a 2 GB tolerance so a disk sold as "51 GB" whose df size
  // lands just under 51*1024 MB (filesystem overhead + GiB/GB rounding) still
  // passes — the requirement is a real ~51 GB disk, not exactly 52224 MB.
  const totalMb = await diskMbOnRoot('size');
  const totalGb = totalMb == null ? null : Math.floor(totalMb / 1024);
  const freeGb = await freeGbOnRoot();
  const requiredTotalMb = (REQUIRED_TOTAL_GB - 2) * 1024; // 2 GB tolerance
  push(`≥${REQUIRED_TOTAL_GB} GB TOTAL disk on / (image ${IMAGE_SIZE_GB} + work ${WORKING_GB} + swap ${SWAP_GB})`,
    totalMb != null && totalMb >= requiredTotalMb,
    totalMb == null
      ? 'could not read disk size on / (SSH probe failed) — re-run once SSH is stable.'
      : `only ${totalGb} GB total on / (need ≈${REQUIRED_TOTAL_GB} GB; the VPS disk is too small to hold the image + working room + swap).`);
  say(`   (info) free on / right now: ${freeGb == null ? 'unknown (probe failed)' : `${freeGb} GB`} — cleanup runs during the deploy, so low free space here is fine.`);

  // Swap: if the live read is below target, don't abort yet — the box may have
  // booted with its fstab swap not yet activated, or the probe hit a transient
  // blip (observed: swap step confirmed 4095 MB, gate 4s later read 0 MB). Try to
  // restore swap from its persisted config and re-probe; only fail if that too
  // comes back short (a box that genuinely has no usable swap).
  let swapMb = await activeSwapMb();
  if (swapMb == null || swapMb < MIN_READY_SWAP_MB) {
    warn(`Swap read ${fmtMb(swapMb)} (< 4 GB) — attempting to restore from /etc/fstab before failing...`);
    swapMb = await restoreSwapMb();
    if (swapMb >= MIN_READY_SWAP_MB) {
      ok(`Swap restored: ${swapMb} MB now active (re-activated from persisted config).`);
    }
  }
  push('≥4 GB swap active', swapMb != null && swapMb >= MIN_READY_SWAP_MB,
    `only ${fmtMb(swapMb)} swap active after restore attempt (need ≥4 GB; /swapfile + /etc/fstab entry must exist and be activatable).`);

  if (requireDocker) {
    const up = await dockerDaemonUp();
    push('Docker daemon responding', up, 'docker info failed — the daemon did not come back after reboot.');
  }

  // SSH stability: we want a stable link before a long deploy, but a single
  // transient blip (sshd MaxStartups throttling right after boot, a momentary load
  // spike) in a back-to-back burst should NOT hard-fail a healthy box. So require a
  // majority (3 of up to 4 probes), spaced ~1s apart, and stop early once 3 succeed.
  let sshOk = 0;
  let sshTried = 0;
  for (let i = 0; i < 4 && sshOk < 3; i++) {
    if (i > 0) await sleep(1000);
    sshTried++;
    if ((await checkSshAvailable()).up) sshOk++;
  }
  const stable = sshOk >= 3;
  push(`SSH stable (${sshOk}/${sshTried} probes, need 3)`, stable,
    `only ${sshOk} of ${sshTried} SSH probes succeeded — the link is shaky or the box is still finalizing.`);

  say('   Readiness summary:');
  for (const r of checks) say(`     ${r.passed ? '✅' : '❌'} ${r.name}${r.passed ? '' : ` — ${r.detail}`}`);

  const notReady = checks.filter((r) => !r.passed);
  if (!notReady.length) {
    ok(`Server ready (${checks.length}/${checks.length} checks passed).`);
    return;
  }
  if (config.forceUnready) {
    warn(`Server NOT fully ready (${notReady.length} failed) but --force-unready is set — proceeding. Failed: ${notReady.map((r) => r.name).join('; ')}.`);
    return;
  }
  console.error(
    `\n>>> ERROR: Server is NOT ready — refusing to continue.` +
    notReady.map((r) => `\n>>>   ❌ ${r.name}: ${r.detail}`).join('') +
    `\n>>> This usually means the box is still finishing a (re)install or lost swap/docker on reboot.` +
    `\n>>> Wait a few minutes and re-run. If you are certain the box is fine, re-run with --force-unready.`,
  );
  process.exit(1);
};

// Helper to check SSH availability
// Probe SSH once. Returns a small status object rather than exiting, so the
// caller (Step 1) owns the retry/timeout policy.
//   { up: true }                 → logged in, server reachable
//   { up: false, badPass: true } → password rejected (ssh exit 5)
//   { up: false }                → not reachable yet (refused/timeout/etc.)
//
// IMPORTANT: exit code 5 (password rejected) is NOT treated as fatal here.
// On a freshly (re)installed Contabo box, cloud-init's finalization transiently
// rejects the CORRECT password with exit 5 while it is still reconfiguring PAM /
// the root account — verified: the same .lenv password that fails during that
// window succeeds a minute later once cloud-init settles. So a single code-5 is
// reported as badPass and RETRIED by the caller; only code 5 that PERSISTS across
// the whole wait window means the password is genuinely wrong.
const checkSshAvailable = async () => {
  try {
    const result = await $({ mirror: false })`sshpass -p ${PASS} ssh ${SSH_OPTS.split(' ')} ${USER}@${IP} echo up`;
    return { up: result.code === 0 };
  } catch (error) {
    const code = error.code ?? error.exitCode;
    if (code === 6) {
      // Host-key mismatch is not transient (we pin StrictHostKeyChecking=no +
      // UserKnownHostsFile=/dev/null, so this really means a bad SERVER_IP).
      console.error('>>> ERROR: Unknown host key. Check SERVER_IP in .lenv');
      process.exit(1);
    }
    if (code === 5) return { up: false, badPass: true };
    return { up: false };
  }
};

// Remote-side paths. __dirname and resolve are already imported in the
// bootstrap block at the top of the file.
const REMOTE_DIR = '/root/hive-control-center';

const SKIP_BACKUP = config.skipBackup;
const BACKUP_ONLY = config.backupOnly;
const PREPARE = config.prepare;
// Contradictory flags: --backup-only runs the backup then exits, so skipping the
// backup would leave nothing to do. Fail fast rather than exit having done zero work.
if (BACKUP_ONLY && SKIP_BACKUP) {
  console.error('>>> ERROR: --backup-only and --skip-backup are mutually exclusive (backup-only would have nothing to do).');
  process.exit(1);
}
// --mtproxy-only is explicitly the non-destructive append path. Reject flags
// that would reboot the box, wipe Docker state, or run a different maintenance
// mode, so a typo can never turn it into a destructive full deploy.
if (MTPROXY_ONLY) {
  const conflicts = [];
  if (config.resetDocker) conflicts.push('--reset-docker');
  if (config.verifyReboot) conflicts.push('--verify-reboot');
  if (PREPARE) conflicts.push('--prepare');
  if (BACKUP_ONLY) conflicts.push('--backup-only');
  if (config.cleanTempArchives !== 'off') conflicts.push(`--clean-temp-archives=${config.cleanTempArchives}`);
  if (conflicts.length) {
    console.error(`>>> ERROR: --mtproxy-only cannot be combined with: ${conflicts.join(', ')}.`);
    console.error('>>>        It is a safe, append-only mode: no reboot, reset, backup, or cleanup.');
    process.exit(1);
  }
}
// Server-side bucket cleanup mode: 'off' | 'dry-run' | 'run'.
// Never delete server-side data we deliberately chose not to back up: if the
// backup is skipped, force 'off' (a dry-run is also pointless with no backup).
// --prepare must never delete anything on the server: a requested 'run' becomes a
// dry run, which still shows what the real deploy will reclaim.
const CLEANUP_AI_DATA = SKIP_BACKUP ? 'off'
  : PREPARE && config.cleanupAiData === 'run' ? 'dry-run'
  : config.cleanupAiData;

// --- Console UI helpers -----------------------------------------------------
const fmtBytes = (n) => {
  if (n == null || isNaN(n)) return '?';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(2)} MiB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GiB`;
};

const fmtDuration = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m${String(s % 60).padStart(2, '0')}s`;
};

// Pretty, consistent output. `say` is a normal line; `note`/`ok`/`warn`/`bad`
// add a leading glyph; `sub` indents detail lines; `banner` frames a section.
const say = (msg = '') => console.log(msg ? `   ${msg}` : '');
const note = (msg) => console.log(`   • ${msg}`);
const ok = (msg) => console.log(`   ✅ ${msg}`);
const warn = (msg) => console.log(`   ⚠️  ${msg}`);
const bad = (msg) => console.error(`   ❌ ${msg}`);
const sub = (msg) => console.log(`        ${msg}`);
const banner = (title) => {
  const line = '─'.repeat(Math.max(8, 64 - title.length));
  console.log(`\n   ┌── ${title} ${line}`);
};

// --- AI session-data backup -------------------------------------------------
// claude & codex write the FULL record of everything they did in every session
// into ~/.hive-mind/{claude,codex} on the server. That data is directly ours
// and is valuable for investigating problems, but keeping it on the server
// indefinitely is a privacy risk (the host is not fully secure). So every deploy
// makes a fresh local backup under ./data/backups/ relative to THIS script.
//
// Three modes (--backup-mode):
//   rsync (DEFAULT) NO compression. rsync a persistent local mirror
//                   (data/backups/mirror/), max-throughput, deltas only, and
//                   RESUMABLE — a dropped connection resumes instead of losing
//                   the whole transfer (the one-shot archive modes do not).
//   pigz            parallel gzip on server, then download one .tar.gz archive.
//   zstd            parallel zstd -19 on server, then download one .tar.zst.
const BACKUPS_ROOT = resolve(__dirname, 'data', 'backups');
const BACKUP_MODE = config.backupMode;

// --- Temp backup-archive lifecycle -----------------------------------------
// The pigz/zstd backup path tars+compresses the AI session data into a TEMP
// archive on the server, downloads it, then removes it. That temp archive lives
// in the server's /tmp under a well-known prefix. Under normal operation it is
// deleted immediately after the download (success OR failure). But if the deploy
// process is killed between creating the archive and reaching that rm — a crash
// during download, an SSH drop, Ctrl-C, an exception in verify — the multi-GB
// archive is orphaned and silently fills the disk (this is exactly how /tmp grew
// to 11 GB of dead backups). To make this self-healing:
//   • every archive is created via remoteArchivePath() (single naming source),
//   • the create/download is wrapped so the rm ALWAYS runs (finally-style),
//   • and every deploy sweeps leftover archives at startup (below), so a crash
//     on one run is cleaned up by the next.
const REMOTE_TMP_DIR = '/tmp';
const REMOTE_ARCHIVE_PREFIX = 'ai-sessions-backup-';
// Glob that matches ONLY our archives (both compressor extensions), anchored to
// the prefix so it can never match unrelated /tmp files.
const REMOTE_ARCHIVE_GLOB = `${REMOTE_TMP_DIR}/${REMOTE_ARCHIVE_PREFIX}*.tar.@(gz|zst)`;
const remoteArchivePath = (ext) => `${REMOTE_TMP_DIR}/${REMOTE_ARCHIVE_PREFIX}${Date.now()}.${ext}`;

// Remove a single known remote archive. Best-effort, never throws (cleanup must
// not turn a real failure into a different one). Safe to call with any path we
// created via remoteArchivePath().
const removeRemoteArchive = async (remotePath) => {
  if (!remotePath) return;
  await ssh(`rm -f ${JSON.stringify(remotePath)}`, { silent: true, ignoreErrors: true });
};

// Startup / standalone sweep: find and (optionally) delete every orphaned
// backup archive matching REMOTE_ARCHIVE_GLOB. Returns { files, bytes, removed }.
// `dryRun` lists without deleting. Uses `find` (not shell globbing) so it works
// whether or not any files match, and reports each file's size so the user sees
// exactly what was reclaimed.
const sweepRemoteArchives = async ({ dryRun = false } = {}) => {
  // List "<bytes>\t<path>" for every match. -maxdepth 1: only the top of /tmp.
  // The name pattern mirrors REMOTE_ARCHIVE_GLOB but as two find -name clauses
  // (find has no @(a|b) syntax). printf keeps it parseable regardless of locale.
  const listCmd =
    `find ${REMOTE_TMP_DIR} -maxdepth 1 -type f ` +
    `\\( -name ${JSON.stringify(`${REMOTE_ARCHIVE_PREFIX}*.tar.gz`)} ` +
    `-o -name ${JSON.stringify(`${REMOTE_ARCHIVE_PREFIX}*.tar.zst`)} \\) ` +
    `-printf '%s\\t%p\\n'`;
  const res = await ssh(listCmd, { silent: true, ignoreErrors: true });
  const rows = (res?.stdout || '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => { const [size, ...rest] = l.split('\t'); return { bytes: parseInt(size, 10) || 0, path: rest.join('\t') }; })
    .filter((r) => r.path);
  const totalBytes = rows.reduce((a, r) => a + r.bytes, 0);

  if (rows.length === 0) {
    note(`No orphaned temp backup archives under ${REMOTE_TMP_DIR} (pattern ${REMOTE_ARCHIVE_PREFIX}*.tar.{gz,zst}).`);
    return { files: [], bytes: 0, removed: 0 };
  }

  note(`${dryRun ? 'Would sweep' : 'Sweeping'} ${rows.length} orphaned temp backup archive(s), ${fmtBytes(totalBytes)} total:`);
  for (const r of rows) sub(`${dryRun ? '·' : '✓'} ${fmtBytes(r.bytes).padStart(9)}  ${r.path}`);

  if (dryRun) {
    note('Dry run — nothing deleted. Re-run with --clean-temp-archives run to delete.');
    return { files: rows, bytes: totalBytes, removed: 0 };
  }

  // Delete exactly the files we listed (by explicit path, so a file created
  // AFTER our listing — e.g. a concurrent deploy's live archive — is never hit).
  let removed = 0;
  for (const r of rows) {
    const rm = await ssh(`rm -f ${JSON.stringify(r.path)}`, { silent: true, ignoreErrors: true });
    if (rm && rm.code === 0) removed++;
    else warn(`Failed to remove ${r.path}`);
  }
  ok(`Swept ${removed}/${rows.length} archive(s), reclaimed ~${fmtBytes(totalBytes)}.`);
  return { files: rows, bytes: totalBytes, removed };
};

// Local counterpart of the remote sweep. A per-run backup dir is only VALID once
// its MANIFEST.json is written (the final step of the verified success path), so
// any dir under data/backups/ that has no MANIFEST.json is an incomplete/aborted
// run's leftover — a partial download from a dropped connection, a checksum
// mismatch, etc. backupViaArchive's finally already removes these on a failure it
// handles; this is the backstop for a process HARD-KILLED before finally ran
// (Ctrl-C, SIGKILL, power loss). Runs at the start of every deploy so a crash is
// self-healing on the next run. Skips the rsync 'mirror' dir (no manifest-per-run
// model). `dryRun` lists without deleting. Returns { dirs, bytes, removed }.
// lstat, NOT stat: the mirror holds symlinks copied verbatim from the server
// (rsync -a), whose targets (/tmp/codex-daemon-…, /home/box/…) do not exist
// locally. stat() follows them and throws ENOENT; and errors are swallowed PER
// ENTRY, never for the whole walk — otherwise the first dangling symlink silently
// truncates the total (a 21 GiB mirror read as 191 MiB and failed Phase-2).
// A symlink counts as its own size (the link text), same as remote `du -sb`.
const localDirBytes = (p) => {
  let total = 0;
  const walk = (q) => {
    let s;
    try { s = lstatSync(q); } catch { return; /* vanished mid-walk */ }
    if (s.isDirectory()) {
      let entries;
      try { entries = readdirSync(q); } catch { return; /* vanished/unreadable */ }
      for (const e of entries) walk(join(q, e));
    } else total += s.size;
  };
  walk(p);
  return total;
};
// ── Append-only history merge (never overwrite, always union) ────────────────
// history.jsonl files are APPEND-ONLY input logs (one JSON object per typed
// prompt/command). The server periodically TRUNCATES them (codex/history.jsonl is
// reset by our own post-backup cleanup; claude's rolls over on its own), so a
// plain rsync --inplace would REPLACE the mirror's long accumulated history with
// the server's short current one — silently losing every older line. That is the
// only place the accumulating-mirror design leaks: no --delete protects added or
// removed FILES, but it does nothing for a file whose CONTENT shrank.
//
// Fix: treat these files as unions. Before rsync we snapshot the mirror's current
// lines; after rsync (which just wrote the server's version over them) we merge
// snapshot ∪ freshly-synced, deduped, and write the union back. The mirror's
// history then grows monotonically and no typed-command line is ever lost.
//
// Relative paths (under the mirror root and, identically, under REMOTE_BASE).
const HISTORY_MERGE_FILES = ['claude/history.jsonl', 'codex/history.jsonl'];

// Split JSONL text into non-empty trimmed lines. Blank lines carry no record and
// would otherwise dedupe to a single spurious "" entry.
const splitJsonlLines = (text) =>
  (text || '').split('\n').map((l) => l.replace(/\r$/, '')).filter((l) => l.trim().length > 0);

// Union two JSONL blobs preserving order: every OLD line first (in its original
// order), then each NEW line not already present. Exact-line dedup — for an
// append-only log, byte-identical lines are true duplicates (same typed input at
// the same timestamp in the same session), and any real re-typing differs in the
// timestamp field so it is correctly kept as a distinct line. Returns the merged
// text (newline-terminated) plus counts for logging/verification.
const mergeJsonlText = (oldText, newText) => {
  const oldLines = splitJsonlLines(oldText);
  const newLines = splitJsonlLines(newText);
  const seen = new Set(oldLines);
  const merged = [...oldLines];
  let added = 0;
  for (const line of newLines) {
    if (!seen.has(line)) { seen.add(line); merged.push(line); added++; }
  }
  return { text: merged.length ? merged.join('\n') + '\n' : '', total: merged.length, oldCount: oldLines.length, newCount: newLines.length, added };
};

// Read a file as utf8, or '' if it does not exist / is unreadable. Never throws.
const readTextOrEmpty = (p) => {
  try { return existsSync(p) ? readFileSync(p, 'utf8') : ''; } catch { return ''; }
};

// Snapshot the mirror's history files BEFORE rsync overwrites them. Returns a map
// { relPath -> priorText } so mergeMirrorHistories() can union them back after.
const snapshotMirrorHistories = (mirrorDir) => {
  const snap = {};
  for (const rel of HISTORY_MERGE_FILES) snap[rel] = readTextOrEmpty(join(mirrorDir, rel));
  return snap;
};

// After rsync, merge each history file's pre-rsync snapshot with what rsync just
// wrote, and persist the union back into the mirror. Idempotent and safe: if the
// snapshot was empty (first ever sync) the file is left exactly as rsync wrote it;
// if rsync brought nothing new the file is unchanged. Returns per-file stats.
const mergeMirrorHistories = (mirrorDir, snapshot) => {
  const results = [];
  for (const rel of HISTORY_MERGE_FILES) {
    const p = join(mirrorDir, rel);
    const priorText = snapshot[rel] || '';
    const syncedText = readTextOrEmpty(p);
    // Nothing on either side ⇒ no file to write (don't create empty files).
    if (!priorText && !syncedText) { results.push({ rel, total: 0, added: 0, skipped: true }); continue; }
    const m = mergeJsonlText(priorText, syncedText);
    // Only rewrite when the union differs from what is on disk (avoid needless churn).
    if (m.text !== syncedText) {
      try {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, m.text);
      } catch (e) { results.push({ rel, error: e.message }); continue; }
    }
    results.push({ rel, total: m.total, oldCount: m.oldCount, newCount: m.newCount, added: m.added, keptFromMirror: Math.max(0, m.total - m.newCount) });
  }
  return results;
};

const sweepLocalPartialBackups = ({ dryRun = false } = {}) => {
  if (!existsSync(BACKUPS_ROOT)) {
    note(`No local backups dir yet (${BACKUPS_ROOT}); nothing to sweep.`);
    return { dirs: [], bytes: 0, removed: 0 };
  }
  // Only per-run archive dirs are named "<ip>_<utcStamp>"; validity = MANIFEST.json.
  const stale = readdirSync(BACKUPS_ROOT, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name !== 'mirror')
    .map((d) => join(BACKUPS_ROOT, d.name))
    .filter((dir) => !existsSync(join(dir, 'MANIFEST.json')))
    .map((dir) => ({ dir, bytes: localDirBytes(dir) }));
  const totalBytes = stale.reduce((a, r) => a + r.bytes, 0);

  if (stale.length === 0) {
    note(`No incomplete local backup dirs under ${BACKUPS_ROOT} (all have MANIFEST.json).`);
    return { dirs: [], bytes: 0, removed: 0 };
  }

  note(`${dryRun ? 'Would remove' : 'Removing'} ${stale.length} incomplete local backup dir(s) (no MANIFEST.json), ${fmtBytes(totalBytes)} total:`);
  for (const r of stale) sub(`${dryRun ? '·' : '✓'} ${fmtBytes(r.bytes).padStart(9)}  ${r.dir}`);

  if (dryRun) {
    note('Dry run — nothing deleted. Re-run with --clean-temp-archives run to delete.');
    return { dirs: stale, bytes: totalBytes, removed: 0 };
  }

  let removed = 0;
  for (const r of stale) {
    try { rmSync(r.dir, { recursive: true, force: true }); removed++; }
    catch (e) { warn(`Failed to remove ${r.dir}: ${e.message}`); }
  }
  ok(`Removed ${removed}/${stale.length} incomplete local backup dir(s), reclaimed ~${fmtBytes(totalBytes)}.`);
  return { dirs: stale, bytes: totalBytes, removed };
};

// Stream `cat REMOTE_FILE` over ssh into a local file with a live progress line
// (downloaded / total, %, current rate, elapsed, ETA). Returns { ok, bytes }.
// The progress line uses \r on STDERR only (not duplicated into the log file).
const sshStreamToFile = async (remoteFile, totalBytes, localPath) => {
  const { spawn } = await import('node:child_process');
  const remoteCmd = `cat ${JSON.stringify(remoteFile)}`;
  note(`Downloading ${fmtBytes(totalBytes)} over SSH → ${localPath}`);
  return new Promise((resolveP) => {
    const args = ['-p', PASS, 'ssh', ...SSH_OPTS.split(' '), `${USER}@${IP}`, remoteCmd];
    const child = spawn('sshpass', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const out = createWriteStream(localPath);
    let bytes = 0;
    const startTime = Date.now();
    let lastTime = startTime, lastBytes = 0;
    let stderrBuf = '';
    child.stdout.on('data', (chunk) => {
      bytes += chunk.length;
      const now = Date.now();
      if (now - lastTime >= 500) {
        const pct = totalBytes > 0 ? (bytes / totalBytes) * 100 : 0;
        const instRate = (bytes - lastBytes) / ((now - lastTime) / 1000);
        const avgRate = bytes / Math.max((now - startTime) / 1000, 0.001);
        const etaMs = avgRate > 0 && totalBytes > bytes ? ((totalBytes - bytes) / avgRate) * 1000 : 0;
        process.stderr.write(
          `\r        ⏳ ${fmtBytes(bytes)} / ${fmtBytes(totalBytes)}  ${pct.toFixed(1)}%  ` +
          `@ ${fmtBytes(instRate)}/s  elapsed ${fmtDuration(now - startTime)}  ETA ${fmtDuration(etaMs)}    `
        );
        lastTime = now; lastBytes = bytes;
      }
    });
    child.stdout.pipe(out);
    child.stderr.on('data', (c) => { stderrBuf += c.toString(); });
    child.on('error', (err) => { process.stderr.write('\n'); bad(`spawn error: ${err.message}`); resolveP({ ok: false, bytes }); });
    child.on('close', (code) => {
      out.end();
      process.stderr.write('\n');
      const elapsed = Date.now() - startTime;
      const avg = bytes / Math.max(elapsed / 1000, 0.001);
      if (code === 0 && bytes === totalBytes) {
        ok(`Downloaded ${fmtBytes(bytes)} in ${fmtDuration(elapsed)} (avg ${fmtBytes(avg)}/s)`);
        resolveP({ ok: true, bytes });
      } else {
        bad(`Download FAILED: got ${fmtBytes(bytes)} of ${fmtBytes(totalBytes)} in ${fmtDuration(elapsed)}`);
        if (stderrBuf.trim()) sub('remote stderr: ' + stderrBuf.trim().split('\n').join(' | '));
        resolveP({ ok: false, bytes });
      }
    });
  });
};

// Compute the SHA-256 of a local file by streaming it (memory-safe for multi-GB
// archives — never loads the whole file into memory).
const sha256OfFile = (path) => new Promise((resolveP, rejectP) => {
  import('node:crypto').then(({ createHash }) => {
    import('node:fs').then(({ createReadStream }) => {
      const h = createHash('sha256');
      const rs = createReadStream(path);
      rs.on('error', rejectP);
      rs.on('data', (c) => h.update(c));
      rs.on('end', () => resolveP(h.digest('hex')));
    }).catch(rejectP);
  }).catch(rejectP);
});

// Compute the SHA-256 of a file on the server (sha256sum prints "<hash>  <path>").
const sha256OfRemote = async (remotePath) => {
  const res = await ssh(`sha256sum ${JSON.stringify(remotePath)}`, { silent: true, ignoreErrors: true });
  const out = (res?.stdout || '').trim().split(/\s+/)[0] || '';
  return /^[0-9a-f]{64}$/.test(out) ? out : null;
};

// Shared: figure out the remote base + which targets exist + raw source size.
const resolveBackupTargets = async () => {
  const homeRes = await ssh('echo $HOME', { silent: true, ignoreErrors: true });
  const remoteHome = (homeRes?.stdout || '').trim() || '/root';
  const REMOTE_BASE = `${remoteHome}/.hive-mind`;
  const TARGETS = [
    { name: 'claude', type: 'dir' },
    { name: 'codex', type: 'dir' },
    { name: 'claude.json', type: 'file' },
  ];
  note(`Source: ${REMOTE_BASE} on ${USER}@${IP}`);
  const present = [];
  for (const t of TARGETS) {
    const check = await ssh(`test -e ${REMOTE_BASE}/${t.name} && echo yes || echo no`, { silent: true, ignoreErrors: true });
    const exists = (check?.stdout || '').trim() === 'yes';
    console.log(`        ${exists ? '✓' : '·'} ${t.name}${exists ? '' : '  (missing)'}`);
    if (exists) present.push(t);
  }
  let srcBytes = null;
  if (present.length) {
    const paths = present.map((t) => `${REMOTE_BASE}/${t.name}`).join(' ');
    const duRes = await ssh(`du -scb ${paths} 2>/dev/null | tail -1 | cut -f1`, { silent: true, ignoreErrors: true });
    const n = parseInt((duRes?.stdout || '').trim(), 10);
    if (n && !isNaN(n)) { srcBytes = n; note(`Source size: ${fmtBytes(srcBytes)} across ${present.length} target(s)`); }
  }
  return { REMOTE_BASE, present, srcBytes, remoteHome };
};

const utcStamp = () => {
  const now = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${now.getUTCFullYear()}-${p(now.getUTCMonth() + 1)}-${p(now.getUTCDate())}T${p(now.getUTCHours())}-${p(now.getUTCMinutes())}-${p(now.getUTCSeconds())}Z`;
};

// MODE pigz / zstd: tar+compress on the server, download the archive, verify.
const backupViaArchive = async (mode, ctx) => {
  const { REMOTE_BASE, present, srcBytes } = ctx;
  // Pick compressor. Honor the requested mode but degrade gracefully if the tool
  // is missing on the server (zstd→pigz→gzip, pigz→gzip).
  const probe = await ssh('command -v zstd >/dev/null 2>&1 && echo zstd; command -v pigz >/dev/null 2>&1 && echo pigz; echo gzip', { silent: true, ignoreErrors: true });
  const have = new Set((probe?.stdout || '').split('\n').map((s) => s.trim()).filter(Boolean));
  let tool = mode;
  if (tool === 'zstd' && !have.has('zstd')) { tool = have.has('pigz') ? 'pigz' : 'gzip'; warn(`zstd not on server; falling back to ${tool}`); }
  if (tool === 'pigz' && !have.has('pigz')) { tool = 'gzip'; warn('pigz not on server; falling back to single-threaded gzip'); }
  const plan = {
    // zstd -19 = strong ratio (smallest download); -T0 = all cores keeps it fast.
    // `verify` decompress-tests the compression stream; `list` walks the tar
    // INSIDE the compression to prove the archive structure is intact and to
    // enumerate its entries (so we can assert the expected ones are present).
    zstd: { ext: 'tar.zst', prog: 'zstd -19 -T0', label: 'zstd -19 (all cores, smallest)',
            verify: (f) => $({ mirror: false })`zstd -t ${f}`, list: (f) => $({ mirror: false })`tar --zstd -tf ${f}` },
    pigz: { ext: 'tar.gz',  prog: 'pigz -6 -p$(nproc)', label: 'pigz -6 (all cores)',
            verify: (f) => $({ mirror: false })`gzip -t ${f}`,  list: (f) => $({ mirror: false })`tar -tzf ${f}` },
    gzip: { ext: 'tar.gz',  prog: 'gzip -6',            label: 'gzip -6 (single-thread)',
            verify: (f) => $({ mirror: false })`gzip -t ${f}`,  list: (f) => $({ mirror: false })`tar -tzf ${f}` },
  }[tool];

  const stamp = utcStamp();
  const backupDir = join(BACKUPS_ROOT, `${IP}_${stamp}`);
  mkdirSync(backupDir, { recursive: true });
  note(`Destination: ${backupDir}`);

  // Single naming source (also what the startup sweep recognizes). Declared
  // before the try so the finally can always target it for removal.
  const remoteArchive = remoteArchivePath(plan.ext);
  const entriesQuoted = present.map((t) => JSON.stringify(t.name)).join(' ');

  // Everything from creating the archive onward is wrapped so that on ANY exit —
  // the success return, any early-return failure, or a thrown exception — we
  // clean up:
  //   • the REMOTE temp archive is always removed ("delete immediately under
  //     normal operation"; the startup sweep is the backstop for a hard kill), and
  //   • on FAILURE the LOCAL partial archive + its backup dir are removed too, so
  //     a broken/aborted download (e.g. a dropped connection, or a checksum/verify
  //     mismatch) never leaves an incomplete, unverified backup on local disk.
  // `succeeded` is flipped true only on the fully-verified success path.
  let succeeded = false;
  try {
  banner(`Phase 1/4 — Compress on server (${plan.label})`);
  note('Runs on the server CPUs; multi-GB data takes tens of seconds.');
  const tc0 = Date.now();
  const tarRes = await ssh(`tar --use-compress-program=${JSON.stringify(plan.prog)} -cf ${remoteArchive} -C ${JSON.stringify(REMOTE_BASE)} ${entriesQuoted}`, { ignoreErrors: true });
  if (!tarRes || tarRes.code !== 0) {
    bad('Remote archive creation failed');
    if (tarRes?.stderr) sub(String(tarRes.stderr).trim());
    return { ok: false };
  }
  const sizeRes = await ssh(`stat -c %s ${remoteArchive}`, { silent: true, ignoreErrors: true });
  const archBytes = parseInt((sizeRes?.stdout || '').trim(), 10);
  if (!archBytes || isNaN(archBytes)) {
    bad('Could not stat remote archive');
    return { ok: false };
  }
  const ratio = srcBytes ? ` (${(srcBytes / archBytes).toFixed(1)}× smaller than ${fmtBytes(srcBytes)})` : '';
  ok(`Compressed in ${fmtDuration(Date.now() - tc0)} → ${fmtBytes(archBytes)}${ratio}`);
  // Fingerprint the archive ON THE SERVER now, so we can prove byte-for-byte
  // identical transfer after download (catches any silent corruption in flight,
  // not just truncation that the size check would catch).
  const remoteSha = await sha256OfRemote(remoteArchive);
  if (remoteSha) sub(`server sha256: ${remoteSha}`);
  else warn('sha256sum unavailable on server; will fall back to size-only transfer check');

  banner(`Phase 2/4 — Download archive`);
  note(`~${fmtDuration((archBytes / (9 * 1024 * 1024)) * 1000)} at ~9 MB/s (link-bound)`);
  const localArchive = join(backupDir, `ai-sessions.${plan.ext}`);
  const pull = await sshStreamToFile(remoteArchive, archBytes, localArchive);
  if (!pull.ok) { bad('Download failed'); return { ok: false }; }

  banner(`Phase 3/4 — Verify local archive (4 independent checks)`);
  // Check 1 — exact size. Cheap truncation guard.
  const onDisk = statSync(localArchive).size;
  if (onDisk !== archBytes) { bad(`Size mismatch (local ${fmtBytes(onDisk)} != remote ${fmtBytes(archBytes)}); NOT valid.`); return { ok: false }; }
  sub(`✓ size matches remote (${fmtBytes(onDisk)})`);

  // Check 2 — end-to-end checksum. Proves the bytes that landed locally are the
  // exact bytes the server hashed (defends against silent in-flight corruption).
  let localSha = null;
  if (remoteSha) {
    localSha = await sha256OfFile(localArchive).catch(() => null);
    if (!localSha) { bad('Could not compute local sha256; cannot prove integrity. NOT valid.'); return { ok: false }; }
    if (localSha !== remoteSha) { bad(`Checksum MISMATCH (server ${remoteSha} != local ${localSha}); transfer corrupted. NOT valid.`); return { ok: false }; }
    sub(`✓ sha256 matches server (${localSha.slice(0, 16)}…)`);
  } else {
    sub('· sha256 skipped (server lacked sha256sum) — relying on size + decompress + tar checks');
  }

  // Check 3 — compression-stream integrity. Decompresses the whole file; fails
  // on any corruption the size/checksum somehow missed (and on a non-hashed run).
  const verify = await plan.verify(localArchive).catch((e) => e);
  if (verify?.code !== 0) { bad(`Local archive failed ${tool} integrity check; NOT a valid backup.`); return { ok: false }; }
  sub(`✓ ${tool} stream decompresses cleanly`);

  // Check 4 — tar structure + expected content. Walk the tar INSIDE the
  // compression: proves the archive is a well-formed tar (not valid compression
  // around garbage) AND that every expected top-level entry is actually present
  // (catches an archive of the wrong/empty directory passing all byte checks).
  const listRes = await plan.list(localArchive).catch((e) => e);
  if (listRes?.code !== 0) { bad('Archive is not a readable tar (structure broken); NOT valid.'); return { ok: false }; }
  const entries = String(listRes.stdout || '').split('\n').map((s) => s.trim()).filter(Boolean);
  if (entries.length === 0) { bad('Archive contains ZERO entries; NOT a valid backup.'); return { ok: false }; }
  // tar lists members as e.g. "claude/", "claude/foo", "claude.json". An expected
  // top-level target is present if any entry equals it or is nested under it.
  const missing = present.filter((t) =>
    !entries.some((e) => e === t.name || e === `${t.name}/` || e.startsWith(`${t.name}/`)));
  if (missing.length) { bad(`Archive is missing expected target(s): ${missing.map((t) => t.name).join(', ')}; NOT valid.`); return { ok: false }; }
  sub(`✓ tar valid, ${entries.length} entries, all ${present.length} target(s) present`);
  ok(`All integrity checks passed`);

  banner(`Phase 4/4 — Write manifest`);
  const manifest = {
    mode, compressor: tool, server_ip: IP, server_user: USER, remote_base: REMOTE_BASE,
    taken_at_utc: new Date().toISOString(), archive: `ai-sessions.${plan.ext}`,
    archive_bytes: archBytes, source_bytes: srcBytes || null,
    sha256: localSha || remoteSha || null,
    entry_count: entries.length,
    verified: { size: true, sha256: Boolean(localSha), decompress: true, tar_listing: true },
    targets: present.map((t) => ({ name: t.name, type: t.type })),
  };
  writeFileSync(join(backupDir, 'MANIFEST.json'), JSON.stringify(manifest, null, 2));
  ok(`Manifest written (records sha256 + entry count + per-check results)`);
  succeeded = true;
  return { ok: true, present, remoteBase: REMOTE_BASE, dir: backupDir, archive: localArchive };
  } finally {
    // Remote temp archive: delete on EVERY exit (success, failure, throw). Under
    // normal operation this is the immediate post-download cleanup; the startup
    // sweep is the backstop for a process killed before we get here.
    await removeRemoteArchive(remoteArchive);
    // Local side: on FAILURE, remove the partial/unverified download and its
    // now-invalid backup dir. A dir is only a valid backup once MANIFEST.json is
    // written (final step of the success path), so anything left by a failed run
    // is pure garbage — a half-downloaded archive, a checksum mismatch, etc. On
    // success we keep everything. Best-effort: never let cleanup mask the real
    // error (which is already being surfaced via the { ok:false } return / throw).
    if (!succeeded) {
      try {
        rmSync(backupDir, { recursive: true, force: true });
        note(`Removed incomplete local backup dir (partial/unverified): ${backupDir}`);
      } catch (e) {
        warn(`Could not remove incomplete local backup dir ${backupDir}: ${e.message}`);
      }
    }
  }
};

// MODE rsync: NO compression. Maintain ONE persistent local mirror that is an
// ACCUMULATING ARCHIVE of everything the server has ever held. rsync transfers
// only changed files (deltas) at max throughput. Live progress comes from
// rsync --info=progress2.
//
// IMPORTANT — accumulate, do NOT mirror deletions. We deliberately do NOT pass
// --delete. Once a file has been copied into the mirror it stays, even after the
// server deletes it. This is the counterpart to the post-backup server cleanup
// (which empties codex/sessions, codex/generated_images and claude/projects to
// free server disk): the ONLY durable copy of that session data is this local
// mirror, so it must never drop files the server pruned. Consequence: the mirror
// is a SUPERSET of the current server state and grows without bound locally — by
// design. That also reshapes Phase-2 verification: we assert the mirror CONTAINS
// (is ≥) the server, never that the two sizes match.
const backupViaRsync = async (ctx) => {
  const { REMOTE_BASE, present, srcBytes } = ctx;
  const { spawn } = await import('node:child_process');
  const mirrorDir = join(BACKUPS_ROOT, 'mirror');
  mkdirSync(mirrorDir, { recursive: true });
  note(`Persistent mirror: ${mirrorDir} (accumulating archive — keeps files the server later deletes)`);

  // rsync tuned for a slow, lossy, high-latency link (measured 2026-10-23: ~300 ms
  // RTT, ~3% loss, ~35 KB/s per stream). The network is the bottleneck, not CPU:
  //   • delta transfer (NO --whole-file): session JSONL files grow by appending,
  //     so only the new tail crosses the link instead of the whole file again;
  //   • zstd stream compression (--rsync-compress): 3.6–6x fewer bytes on JSONL.
  //     This is in-protocol compression; no archive file is created.
  // NO --delete (accumulate — keep files pruned on the server; see the function
  // header), partial+inplace for resumability, human progress.
  const rshOpts = SSH_OPTS; // reuse the same ssh hardening
  const rsh = `sshpass -p ${PASS} ssh ${rshOpts}`;
  const srcSpec = present.map((t) => `${USER}@${IP}:${REMOTE_BASE}/${t.name}`);
  const compressArgs = config.rsyncCompress === 'zstd'
    ? ['--compress', '--compress-choice=zstd', '--compress-level=3']
    : [];
  const rsyncArgs = [
    '-a',                        // archive: perms, times, symlinks, recursive
    // NOTE: intentionally NO --delete — the mirror accumulates and keeps files
    // the server later prunes (see the function header). Do not re-add it.
    // NOTE: intentionally NO --whole-file — it disables the delta algorithm.
    ...compressArgs,
    '--partial', '--inplace',    // resumable, write in place (less temp churn)
    '--human-readable',
    '--info=progress2,stats1',   // single overall progress line + summary
    '-e', `sshpass -p ${mask(PASS)} ssh ${rshOpts}`, // shown (masked) for clarity; real one set below
  ];
  // Print a reproducible (masked) command, then run with the real -e.
  note(`rsync ${rsyncArgs.join(' ')} ${srcSpec.map((s) => s).join(' ')} ${mirrorDir}/`);
  const realArgs = [
    '-a', ...compressArgs, '--partial', '--inplace',
    '--human-readable', '--info=progress2,stats1',
    '-e', rsh, ...srcSpec, `${mirrorDir}/`,
  ];

  // Snapshot append-only history files BEFORE rsync overwrites them, so we can
  // union the mirror's accumulated lines back in afterward (see the merge helpers).
  const historySnapshot = snapshotMirrorHistories(mirrorDir);

  banner(`Phase 1/2 — rsync mirror (deltas only, ${config.rsyncCompress === 'zstd' ? 'zstd stream compression' : 'no compression'})`);
  const t0 = Date.now();
  const rcode = await new Promise((resolveP) => {
    const child = spawn('rsync', realArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
    let errBuf = '';
    // rsync prints progress with \r — forward to our stderr so it animates in
    // the terminal but does not spam the log with thousands of lines.
    let outBuf = '';
    let lastLen = 0;
    const emit = (text, permanent) => {
      const line = `        ${text.trim()}`;
      process.stderr.write(`\r${line.padEnd(lastLen)}${permanent ? '\n' : ''}`);
      lastLen = permanent ? 0 : line.length;
    };
    child.stdout.on('data', (c) => {
      outBuf += c.toString();
      let i;
      while ((i = outBuf.search(/[\r\n]/)) !== -1) {
        const seg = outBuf.slice(0, i);
        const permanent = outBuf[i] === '\n';
        outBuf = outBuf.slice(i + 1);
        if (seg.trim()) emit(seg, permanent);
      }
    });
    child.stderr.on('data', (c) => { errBuf += c.toString(); });
    child.on('error', (e) => { bad(`rsync spawn error: ${e.message}`); resolveP(1); });
    child.on('close', (code) => { if (outBuf.trim()) emit(outBuf, true); else if (lastLen) process.stderr.write('\n'); if (errBuf.trim()) sub('rsync stderr: ' + errBuf.trim().split('\n').join(' | ')); resolveP(code); });
  });
  // rsync exit 24 = "some files vanished before they could be transferred". This
  // is EXPECTED — and benign — when mirroring a LIVE server: the bot writes
  // transient temp/lock/snapshot files (e.g. codex/tmp/.../.lock) that rsync
  // enumerates then finds gone by the time it goes to copy them. The real data
  // still transfers in full (the stats line confirms it). rsync itself classes
  // 24 as a WARNING, not an error. Treating it as fatal made every presync of a
  // running server fail, so accept it (with a note) and let Phase-2 verification
  // be the real integrity gate. Everything else non-zero is a genuine failure.
  if (rcode === 24) {
    warn('rsync reported exit 24 (some files vanished mid-transfer) — expected for a live server; treating as OK. Phase-2 size verification will confirm integrity.');
  } else if (rcode !== 0) {
    bad(`rsync failed (exit ${rcode})`); return { ok: false };
  }
  ok(`Mirror synced in ${fmtDuration(Date.now() - t0)}`);

  // Merge append-only history files: union the pre-rsync snapshot with what rsync
  // just wrote, so the server truncating (or our cleanup resetting) history.jsonl
  // never shrinks the mirror's accumulated copy. Runs before Phase-2 so the size
  // check sees the merged (≥ server) file.
  const historyMerge = mergeMirrorHistories(mirrorDir, historySnapshot);
  for (const r of historyMerge) {
    if (r.error) { warn(`history merge ${r.rel}: ${r.error}`); }
    else if (r.skipped) { /* nothing on either side — no file */ }
    else if (r.added > 0 || r.keptFromMirror > 0) {
      note(`history merged ${r.rel}: ${r.total} lines = ${r.total - r.added - r.keptFromMirror} on both sides + ${r.added} new from server + ${r.keptFromMirror} kept that only the mirror has`);
    }
  }

  banner('Phase 2/2 — Verify mirror (presence + mirror ⊇ server per target)');
  // For each target: confirm it exists locally, is non-empty, AND the mirror
  // CONTAINS the current server state — i.e. mirror bytes ≥ server bytes (minus a
  // small tolerance). rsync exit 0/24 already implies a faithful copy, but an
  // independent remote-vs-local size check is cheap defense-in-depth and catches a
  // mirror that silently diverged (e.g. a prior interrupted run that lost data).
  // (localDirBytes is defined once at module scope, near the sweep helpers.)
  //
  // SUPERSET, not equality. The mirror is an ACCUMULATING archive (no --delete) and
  // the post-backup cleanup EMPTIES the big server dirs, so the mirror is normally
  // LARGER than the server — often by many GB. That is the healthy state, not a
  // failure. So the only size condition we fail on is the mirror being materially
  // SMALLER than the server (mirror < server − tolerance) — that would mean the
  // sync did not capture data the server currently holds. Mirror ≥ server always
  // passes. We keep a small tolerance because the server is LIVE: between rsync's
  // file enumeration and this `du` the bot writes transient temp/lock/snapshot
  // files (esp. under codex/tmp), so the server can momentarily grow a little past
  // what we just synced without meaning any real data was missed.
  const SIZE_TOLERANCE_RATIO = 0.02;             // server may exceed mirror by 2%…
  const SIZE_TOLERANCE_FLOOR = 16 * 1024 * 1024; // …or 16 MiB, whichever is larger
  let allOk = true;
  const checked = [];
  for (const t of present) {
    const p = join(mirrorDir, t.name);
    if (!existsSync(p)) { allOk = false; console.log(`        ✗ ${t.name} MISSING in mirror`); continue; }
    const local = localDirBytes(p);
    const remRes = await ssh(`du -sb ${JSON.stringify(`${REMOTE_BASE}/${t.name}`)} 2>/dev/null | cut -f1`, { silent: true, ignoreErrors: true });
    const remote = parseInt((remRes?.stdout || '').trim(), 10);
    if (local === 0) { allOk = false; console.log(`        ✗ ${t.name} is EMPTY (0 bytes) in mirror`); continue; }
    // contains_server: does the mirror hold at least what the server currently has?
    let containsServer = true; // no remote reading ⇒ can't disprove; trust rsync 0/24
    if (remote && !isNaN(remote)) {
      const shortfall = remote - local;                                  // >0 ⇒ mirror missing data
      const allowed = Math.max(SIZE_TOLERANCE_FLOOR, remote * SIZE_TOLERANCE_RATIO);
      if (shortfall > allowed) {
        allOk = false; containsServer = false;
        console.log(`        ✗ ${t.name} mirror is SMALLER than server beyond tolerance (server ${fmtBytes(remote)} vs mirror ${fmtBytes(local)}, shortfall ${fmtBytes(shortfall)} > allowed ${fmtBytes(allowed)}) — sync missed data`);
        continue;
      }
      if (local > remote) {
        // Expected steady state: mirror has accumulated history the server pruned.
        console.log(`        ✓ ${t.name} (mirror ${fmtBytes(local)} ⊇ server ${fmtBytes(remote)}; keeps ${fmtBytes(local - remote)} the server no longer has)`);
        checked.push({ name: t.name, type: t.type, bytes: local, server_bytes: remote, contains_server: true });
        continue;
      }
      if (shortfall > 0) {
        console.log(`        ✓ ${t.name} (${fmtBytes(local)}, ~matches server ${fmtBytes(remote)}, server ahead by ${fmtBytes(shortfall)} within tolerance — live-server churn)`);
        checked.push({ name: t.name, type: t.type, bytes: local, server_bytes: remote, contains_server: true });
        continue;
      }
    }
    console.log(`        ✓ ${t.name} (${fmtBytes(local)}${remote ? `, ⊇ server ${fmtBytes(remote)}` : ''})`);
    checked.push({ name: t.name, type: t.type, bytes: local, server_bytes: remote || null, contains_server: containsServer });
  }
  if (!allOk) { bad('Mirror verification failed (missing, empty, or mirror smaller than server); NOT a valid backup.'); return { ok: false }; }
  const manifest = {
    mode: 'rsync', server_ip: IP, server_user: USER, remote_base: REMOTE_BASE,
    taken_at_utc: new Date().toISOString(), mirror: 'mirror', source_bytes: srcBytes || null,
    accumulating: true, // no --delete: mirror keeps files the server later prunes
    verified: { presence: true, non_empty: true, contains_server: true },
    targets: checked,
  };
  writeFileSync(join(mirrorDir, 'MANIFEST.json'), JSON.stringify(manifest, null, 2));
  ok(`Mirror verified (${present.length} target(s): present, non-empty, ⊇ server)`);
  return { ok: true, present, remoteBase: REMOTE_BASE, dir: mirrorDir, mirror: mirrorDir };
};

// Dispatch the chosen backup mode. Returns { ok, present, remoteBase, dir, ... }.
// Never deletes server data — cleanup is a separate, gated step.
const backupAiData = async () => {
  const ctx = await resolveBackupTargets();
  if (ctx.present.length === 0) {
    note('No AI session data present on server — nothing to back up.');
    return { ok: true, present: [], remoteBase: ctx.REMOTE_BASE, dir: null };
  }
  note(`Backup mode: ${BACKUP_MODE}`);
  if (BACKUP_MODE === 'rsync') return backupViaRsync(ctx);
  return backupViaArchive(BACKUP_MODE, ctx);
};

// --- Server-side bucket cleanup ---------------------------------------------
// After a verified-OK backup, reclaim server disk by EMPTYING only the three
// large, purely-historical AI-data buckets (NOT the whole claude/codex dirs, so
// config/auth/plugins/skills/live-state DBs survive and the bot keeps running):
//
//   codex/sessions           rollout transcripts — the multi-GB bulk
//   codex/generated_images   per-session PNGs
//   claude/projects          per-run project dirs
//
// Plus a conservative reset of the ONE index that directly references what we
// removed and would otherwise dangle: codex/history.jsonl (session_id index).
// We do NOT touch codex/state_*.sqlite, logs/goals/memories DBs, claude/tasks,
// claude/session-env, plugins, skills, auth — those are live/coupled state.
//
// SAFETY — mirror ⊇ bucket, per bucket, before deleting. Cleanup only runs after
// backupAiData() returned ok, but we ALSO re-check, per bucket, that the local
// mirror already contains at least as many bytes as that bucket on the server
// (allowing the same small live-churn tolerance as Phase-2). A bucket is emptied
// ONLY if its own mirror copy is proven present and ⊇ the server. Any bucket that
// fails the check is skipped (never deleted) and flagged. This is the durable
// guarantee that we never delete server data the mirror hasn't captured.
//
// mode: 'dry-run' shows sizes + the per-bucket check and deletes NOTHING (safe to
// run with a task executing on the server); 'run' performs the deletions.
const CLEANUP_BUCKETS = [
  { target: 'codex',  sub: 'sessions' },
  { target: 'codex',  sub: 'generated_images' },
  { target: 'claude', sub: 'projects' },
];
// Coupled index files to reset (truncate to empty) when their bucket is emptied.
// Keyed by the bucket "target/sub" so a skipped bucket does not reset its index.
const CLEANUP_COUPLED_INDEXES = {
  'codex/sessions': ['codex/history.jsonl'], // indexes sessions by session_id
};

const remoteDuBytes = async (remotePath) => {
  const res = await ssh(`du -sb ${JSON.stringify(remotePath)} 2>/dev/null | cut -f1`, { silent: true, ignoreErrors: true });
  const n = parseInt((res?.stdout || '').trim(), 10);
  return Number.isNaN(n) ? null : n; // null = missing; 0 = present but empty
};

// Empty the buckets. `backup` is the verified result from backupAiData().
// Returns { attempted, emptied, skipped, reclaimedBytes, dryRun }.
const cleanupServerBuckets = async (backup, mode /* 'dry-run' | 'run' */) => {
  const dryRun = mode === 'dry-run';
  const REMOTE_BASE = backup.remoteBase;
  const mirrorDir = join(BACKUPS_ROOT, 'mirror');
  // Per-bucket mirror verification is only meaningful for the rsync mirror mode
  // (that is where a local per-bucket copy exists). For archive modes we rely on
  // the whole-backup verify that already gated us here, and note that the
  // per-bucket check is not applicable.
  const haveMirror = BACKUP_MODE === 'rsync' && existsSync(mirrorDir);
  // Same tolerance the mirror Phase-2 verify uses (server may be a touch ahead).
  const TOL_RATIO = 0.02, TOL_FLOOR = 16 * 1024 * 1024;

  // Only consider buckets whose parent target was actually present/backed up.
  const presentNames = new Set((backup.present || []).map((t) => t.name));
  const buckets = CLEANUP_BUCKETS.filter((b) => presentNames.has(b.target));
  if (buckets.length === 0) {
    note('None of the cleanup buckets’ parent targets were backed up; nothing to clean.');
    return { attempted: 0, emptied: 0, skipped: 0, reclaimedBytes: 0, dryRun };
  }

  let emptied = 0, skipped = 0, reclaimedBytes = 0;
  for (const b of buckets) {
    const rel = `${b.target}/${b.sub}`;
    const remotePath = `${REMOTE_BASE}/${rel}`;
    // Belt-and-braces path guard. This runs by default on every deploy and ends in
    // a destructive `find -delete`, so refuse to proceed unless the target path is
    // unmistakably one of our buckets: absolute, contains "/.hive-mind/", and ends
    // in the exact expected "<target>/<sub>". A malformed REMOTE_BASE (empty, "/",
    // etc.) can therefore never turn into a wrong-directory wipe.
    const expectedSuffix = `/.hive-mind/${rel}`;
    if (!remotePath.startsWith('/') || !remotePath.includes('/.hive-mind/') || !remotePath.endsWith(expectedSuffix)) {
      skipped++;
      warn(`SKIP ${rel} — refusing to clean unexpected path ${JSON.stringify(remotePath)} (failed safety path check).`);
      continue;
    }
    const serverBytes = await remoteDuBytes(remotePath);
    if (serverBytes == null) { sub(`· ${rel} — not present on server; skipping`); continue; }
    if (serverBytes === 0) { sub(`· ${rel} — already empty on server; nothing to do`); continue; }

    // Per-bucket safety gate: mirror must already contain this bucket (⊇ server).
    let gateOk = true, gateWhy = '';
    if (haveMirror) {
      const mirrorPath = join(mirrorDir, rel);
      if (!existsSync(mirrorPath)) { gateOk = false; gateWhy = 'not in mirror'; }
      else {
        const mBytes = localDirBytes(mirrorPath);
        const shortfall = serverBytes - mBytes; // >0 ⇒ mirror missing data
        const allowed = Math.max(TOL_FLOOR, serverBytes * TOL_RATIO);
        if (mBytes === 0) { gateOk = false; gateWhy = 'mirror copy is empty'; }
        else if (shortfall > allowed) { gateOk = false; gateWhy = `mirror smaller than server by ${fmtBytes(shortfall)} (> allowed ${fmtBytes(allowed)})`; }
        else gateWhy = mBytes >= serverBytes
          ? `mirror ${fmtBytes(mBytes)} ⊇ server ${fmtBytes(serverBytes)}`
          : `mirror ${fmtBytes(mBytes)} ~⊇ server ${fmtBytes(serverBytes)} (within tolerance)`;
      }
    } else {
      gateWhy = 'archive-mode backup already verified whole (no per-bucket mirror check)';
    }

    if (!gateOk) {
      skipped++;
      warn(`SKIP ${rel} (${fmtBytes(serverBytes)}) — safety gate failed: ${gateWhy}. NOT emptied.`);
      continue;
    }

    if (dryRun) {
      sub(`· WOULD empty ${rel.padEnd(24)} ${fmtBytes(serverBytes).padStart(9)}  [${gateWhy}]`);
      const idxs = CLEANUP_COUPLED_INDEXES[rel] || [];
      for (const idx of idxs) sub(`    · WOULD reset index ${idx}`);
      reclaimedBytes += serverBytes;
      emptied++; // "would empty" count in dry-run
      continue;
    }

    // Real delete. Empty the bucket's CONTENTS but keep the dir itself (the bot
    // expects the directory to exist). find … -delete removes children; the
    // `-mindepth 1` keeps the bucket dir. Best-effort; a live task may be writing
    // new files concurrently — those simply reappear and are caught next run.
    sub(`✓ emptying ${rel.padEnd(24)} ${fmtBytes(serverBytes).padStart(9)}  [${gateWhy}]`);
    const del = await ssh(`find ${JSON.stringify(remotePath)} -mindepth 1 -delete`, { silent: true, ignoreErrors: true });
    if (!del || del.code !== 0) { skipped++; warn(`Failed to empty ${rel} (rm error); left in place.`); continue; }
    // Reset coupled indexes (truncate to empty, keep the file so the bot can append).
    for (const idx of (CLEANUP_COUPLED_INDEXES[rel] || [])) {
      const idxPath = `${REMOTE_BASE}/${idx}`;
      await ssh(`test -f ${JSON.stringify(idxPath)} && : > ${JSON.stringify(idxPath)}`, { silent: true, ignoreErrors: true });
      sub(`    ✓ reset index ${idx}`);
    }
    emptied++; reclaimedBytes += serverBytes;
  }

  return { attempted: buckets.length, emptied, skipped, reclaimedBytes, dryRun };
};

// Main execution
let step = 0;
let lastStepAt = Date.now();
const scriptStartedAt = Date.now();
// Each step prints a wall-clock timestamp, how long the PREVIOUS step took, and
// total elapsed — so when something is slow it is obvious where the time went.
const nextStep = (msg) => {
  const now = Date.now();
  if (step > 0) console.log(`>>> ⏱  (previous step took ${fmtDuration(now - lastStepAt)}, ${fmtDuration(now - scriptStartedAt)} total)`);
  lastStepAt = now;
  const ts = new Date().toISOString().replace('T', ' ').replace(/\..+/, '');
  console.log(`\n>>> ── Step ${++step}: ${msg}  [${ts} UTC]`);
};

// ── Append-only MTProxy path ─────────────────────────────────────────────────
// This is intentionally a separate, tiny flow: it runs right after the SSH probe
// and BEFORE the OS gate, reboot, readiness gate, backup/cleanup, Docker/Node
// provisioning and the real hive-mind deploy. Nothing here may stop, restart,
// prune, or overwrite the existing deployment.
const MTPROXY_ONLY_REMOTE_DIR = '/root/.hive-mtproxy-only';
const runMtproxyOnly = async () => {
  nextStep('MTProxy-only: preflight (must not disturb the running deployment)');

  // Never interfere with an in-flight deploy: abort instead of killing it.
  const inProgress = await ssh("pgrep -af 'node .*deploy-docker\\.mjs' || true", { silent: true, ignoreErrors: true });
  const runningDeploys = (inProgress?.stdout || '').split('\n').map((l) => l.trim()).filter(Boolean);
  if (runningDeploys.length) {
    console.error('>>> ERROR: A deploy-docker.mjs process is already running on the server:');
    for (const line of runningDeploys) console.error(`>>>        ${line}`);
    console.error('>>>        Refusing to interfere. Wait for it to finish, or re-run with --mtproxy-only later.');
    process.exit(1);
  }
  ok('No deploy-docker.mjs is running');

  // Do NOT install Docker/Node in this mode: that changes the host and is not
  // needed on an already-deployed box. Fail with a clear hint instead.
  if (!(await dockerDaemonUp())) {
    console.error('>>> ERROR: Docker is not running on the server.');
    console.error('>>>        --mtproxy-only never installs or starts Docker (that could disturb the bot).');
    console.error('>>>        Run the normal deploy once, then retry --mtproxy-only.');
    process.exit(1);
  }
  ok('Docker daemon is already running');
  const nodeCheck = await ssh('node --version && npm --version', { silent: true, ignoreErrors: true });
  if (nodeCheck?.code !== 0) {
    console.error('>>> ERROR: Node.js/npm is not available on the server.');
    console.error('>>>        --mtproxy-only never installs them (that could disturb the bot).');
    console.error('>>>        Run the normal deploy once, then retry --mtproxy-only.');
    process.exit(1);
  }
  ok(`Node.js/npm available (${(nodeCheck.stdout || '').trim().split('\n').join(', ')})`);

  // Read-only status of the bot, for the log only.
  const botStatus = (await ssh(`docker inspect -f '{{.State.Status}}' hive-mind 2>/dev/null || echo missing`, { silent: true, ignoreErrors: true }))?.stdout?.trim() || 'missing';
  if (botStatus === 'running') ok('hive-mind is running — it will not be touched');
  else warn(`hive-mind status is "${botStatus}" — this run will not change it either way`);

  // Idempotent: if the proxy is already up and neither an explicit update nor
  // verification was requested, do nothing at all (no pull, no rm, no restart,
  // no file copy). This is the safe re-run path.
  const proxyStatus = (await ssh(`docker inspect -f '{{.State.Status}}' ${MTPROXY_CONTAINER} 2>/dev/null || echo missing`, { silent: true, ignoreErrors: true }))?.stdout?.trim() || 'missing';
  if (proxyStatus === 'running' && !config.mtproxyUpdate && !config.verifyMtproxy) {
    const policy = (await ssh(`docker inspect -f '{{.HostConfig.RestartPolicy.Name}}' ${MTPROXY_CONTAINER} 2>/dev/null || echo none`, { silent: true, ignoreErrors: true }))?.stdout?.trim() || 'none';
    ok(`${MTPROXY_CONTAINER} is already running — leaving it and hive-mind untouched`);
    if (policy === 'unless-stopped') ok(`${MTPROXY_CONTAINER} restart policy is unless-stopped`);
    else warn(`${MTPROXY_CONTAINER} restart policy is "${policy}" (not unless-stopped); left unchanged`);
    note(`Connection link: cat ${MTPROXY_LINK_PATH}`);
    return;
  }
  if (proxyStatus === 'running' && config.mtproxyUpdate) {
    warn(`${MTPROXY_CONTAINER} is running; --mtproxy-update will recreate ONLY that proxy container (hive-mind stays untouched).`);
  }

  // Install/start the proxy only. Copy the current script + .lenv to an isolated
  // root-only directory so we never overwrite the deployment files in use.
  nextStep('MTProxy-only: installing or starting the proxy container');
  note(`Using isolated staging dir ${MTPROXY_ONLY_REMOTE_DIR} (root-only; removed afterwards)`);
  const innerFlags = [
    '--mtproxy-only',
    config.mtproxyUpdate ? '--mtproxy-update' : '',
    config.verifyMtproxy ? '--verify-mtproxy' : '',
    `--mtproxy-engine ${MTPROXY_ENGINE}`,
    `--mtproxy-port ${MTPROXY_PORT}`,
    config.mtproxyMss ? `--mtproxy-mss ${JSON.stringify(config.mtproxyMss)}` : '',
    config.mtproxyImage ? `--mtproxy-image ${JSON.stringify(config.mtproxyImage)}` : '',
    config.mtproxyClassicImage ? `--mtproxy-classic-image ${JSON.stringify(config.mtproxyClassicImage)}` : '',
    config.mtproxyFrontingHost ? `--mtproxy-fronting-host ${JSON.stringify(config.mtproxyFrontingHost)}` : '',
    SHOW_SECRETS ? '--dangerously-show-secrets' : '',
  ].filter(Boolean).join(' ');
  try {
    await ssh(`rm -rf ${MTPROXY_ONLY_REMOTE_DIR} && mkdir -p ${MTPROXY_ONLY_REMOTE_DIR} && chmod 700 ${MTPROXY_ONLY_REMOTE_DIR}`, { silent: true });
    await scp(resolve(__dirname, 'deploy-docker.mjs'), `${MTPROXY_ONLY_REMOTE_DIR}/deploy-docker.mjs`);
    await scp(resolve(__dirname, '.lenv'), `${MTPROXY_ONLY_REMOTE_DIR}/.lenv`);
    await ssh(`chmod 600 ${MTPROXY_ONLY_REMOTE_DIR}/.lenv && chmod +x ${MTPROXY_ONLY_REMOTE_DIR}/deploy-docker.mjs`, { silent: true });
    await sshTTY(`cd ${MTPROXY_ONLY_REMOTE_DIR} && exec node deploy-docker.mjs ${innerFlags}`);
  } finally {
    await ssh(`rm -rf ${MTPROXY_ONLY_REMOTE_DIR}`, { silent: true, ignoreErrors: true });
  }

  const finalStatus = (await ssh(`docker inspect -f '{{.State.Status}}' ${MTPROXY_CONTAINER} 2>/dev/null || echo missing`, { silent: true, ignoreErrors: true }))?.stdout?.trim() || 'missing';
  if (finalStatus !== 'running') {
    console.error(`>>> ERROR: ${MTPROXY_CONTAINER} did not end up running (status: ${finalStatus}).`);
    process.exit(1);
  }
  ok(`${MTPROXY_CONTAINER} is running; hive-mind was never stopped, restarted, or modified`);
};

// Wrapped in try/catch so failures route to fatal() (full untruncated output +
// log path as the last line) rather than Node's default truncating handler.
try {

nextStep('Checking SSH availability');
// A freshly (re)installed / just-rebooted box can take several minutes to come
// back: sshd not up yet (connection refused/timeout), and — while cloud-init
// finalizes — the CORRECT password transiently rejected with exit 5. We tolerate
// BOTH here and keep retrying up to SSH_WAIT_MS. A genuinely wrong password shows
// up as code 5 that NEVER clears, so we only give up on it after the full window
// (and only if we never once got in), which distinguishes it from the transient
// cloud-init rejection. This is the fix for a restart that "failed to resume"
// because the previous code treated the first transient code 5 as fatal.
const SSH_WAIT_MS = 10 * 60 * 1000; // 10 min — covers Contabo reboot + cloud-init
const sshWaitStart = Date.now();
let sshBadPassSeen = false;
for (;;) {
  const probe = await checkSshAvailable();
  if (probe.up) break;
  const elapsed = Date.now() - sshWaitStart;
  if (probe.badPass) sshBadPassSeen = true;
  if (elapsed >= SSH_WAIT_MS) {
    if (sshBadPassSeen) {
      console.error(
        `\n>>> ERROR: SSH password kept being rejected for ${Math.round(SSH_WAIT_MS / 60000)} min. ` +
        `The server never accepted it — check SERVER_PASS in .lenv (a Contabo OS reinstall resets the root password).`,
      );
    } else {
      console.error(
        `\n>>> ERROR: Server ${USER}@${IP} did not become reachable within ${Math.round(SSH_WAIT_MS / 60000)} min. ` +
        `Check that the box is powered on and SERVER_IP is correct.`,
      );
    }
    process.exit(1);
  }
  warn(
    probe.badPass
      ? `SSH password rejected (server likely still finalizing after boot) — retrying in 10s [${Math.round(elapsed / 1000)}s/${Math.round(SSH_WAIT_MS / 1000)}s]`
      : `SSH not available, retrying in 10s [${Math.round(elapsed / 1000)}s/${Math.round(SSH_WAIT_MS / 1000)}s]`,
  );
  await sleep(10000);
}
ok(`Server ${USER}@${IP} is reachable`);

// Append-only exit: skip the OS gate, reboot, readiness gate, backup/cleanup,
// Docker/Node provisioning, deploy-file copy, and the hive-mind deploy itself.
if (MTPROXY_ONLY) {
  await runMtproxyOnly();
  console.log(`\n>>> ✅ MTProxy-only run complete in ${fmtDuration(Date.now() - scriptStartedAt)} total. hive-mind was left untouched.`);
  process.exit(0);
}

// ── OS gate ────────────────────────────────────────────────────────────────
// This deploy path is validated ONLY on Ubuntu 24.04. The Docker install below
// adds Docker's apt repo pinned to the distro codename, and the box image / bot
// runtime are built against this release. A Contabo reinstall can silently land
// a different OS (we have seen Debian 12 come back from a "Docker" image), so
// refuse to provision anything until we have confirmed the exact release.
nextStep('Verifying server OS is Ubuntu 24.04');
const osRelease = (await ssh('cat /etc/os-release', { silent: true, ignoreErrors: true }))?.stdout || '';
const osField = (k) => (osRelease.match(new RegExp(`^${k}=\"?([^\"\\n]*)\"?`, 'm'))?.[1] || '').trim();
const osId = osField('ID');
const osVersionId = osField('VERSION_ID');
const osPretty = osField('PRETTY_NAME') || '(unknown)';
if (osId !== 'ubuntu' || osVersionId !== '24.04') {
  console.error(
    `\n>>> ERROR: Unsupported server OS: ${osPretty} (ID=${osId || '?'}, VERSION_ID=${osVersionId || '?'}).` +
    `\n>>> This deploy requires Ubuntu 24.04. Reinstall the server with Ubuntu 24.04 and retry.`,
  );
  process.exit(1);
}
ok(`Server OS OK: ${osPretty}`);

// ── Wait for cloud-init & apt/dpkg to settle ────────────────────────────────
// A freshly reinstalled / just-rebooted Contabo box is NOT ready the moment sshd
// answers: cloud-init is still running its final modules, and unattended-upgrades
// holds the dpkg/apt locks. Doing heavy work (apt installs, a 27 GB image pull, a
// docker commit) on top of that in-flight provisioning is what produced the
// flaky failures — transient password rejects, apt-lock contention, and (with no
// swap) the OOM reboot that wiped the in-progress deploy at Step 20.
//
// So block here until the box is genuinely quiescent, DETERMINISTICALLY rather
// than by luck:
//   1. `cloud-init status --wait` returns once cloud-init has finished. NOTE:
//      Contabo's seed has a broken `bootcmd` so cloud-init always ends in state
//      `error` on this box — that is expected and NOT a reason to abort; we only
//      care that it has FINISHED, not that it succeeded.
//   2. Wait for unattended-upgrades / apt / dpkg processes to exit and for the
//      dpkg/apt locks to free, so our own apt calls won't collide with them.
// Bounded so a stuck box can't hang the deploy forever; if the wait times out we
// warn and continue (the apt() helper has its own per-call lock wait as backstop).
// Readiness accumulator: each provisioning check records a pass/fail here, and a
// single HARD gate (below, before any install/backup) aborts the deploy if the
// box is not fully ready. This is the guarantee that a half-reinstalled VPS is
// never provisioned into a broken state — we verify everything is perfectly
// configured FIRST, and only then install. `--force-unready` downgrades the gate
// to a warning for a known-good box that the checks falsely flag.
const readiness = [];
const requireReady = (name, passed, detail) => { readiness.push({ name, passed: !!passed, detail: detail || '' }); };
// OS was already hard-gated above (it exits on anything but Ubuntu 24.04), so if we
// reached here it passed — record it so the readiness summary is complete.
requireReady(`OS is Ubuntu 24.04 (${osPretty})`, true);

nextStep('Waiting for cloud-init and apt/dpkg to settle (fresh boxes are still provisioning)');
{
  const SETTLE_WAIT_S = 600; // 10 min hard cap on the whole settle phase
  // 1) cloud-init: run `status --wait` in the background with our own timeout so a
  // hung cloud-init cannot block us indefinitely. Tolerate a non-zero exit (the
  // Contabo bootcmd error), a missing cloud-init, and the timeout alike.
  const ci = await ssh(
    `if command -v cloud-init >/dev/null 2>&1; then ` +
    `timeout ${SETTLE_WAIT_S} cloud-init status --wait >/dev/null 2>&1; ` +
    `echo "cloud-init: $(cloud-init status 2>/dev/null | head -1 | sed 's/^status: //')"; ` +
    `else echo "cloud-init: (not present)"; fi`,
    { silent: true, ignoreErrors: true },
  );
  say(`   ${(ci?.stdout || 'cloud-init: (unknown)').trim()} — finished (state is informational; Contabo's bootcmd error is expected)`);

  // 2) Wait for apt/dpkg to be idle. The AUTHORITATIVE signal is the dpkg/apt
  // lock files — an in-progress `apt`/`dpkg`/unattended-upgrade holds one of them,
  // so `fuser` on those is a true "busy" indicator with no false positives.
  //
  // We deliberately do NOT match on process name. `unattended-upgrade-shutdown
  // --wait-for-signal` (PID from systemd's apt-daily) runs PERMANENTLY in the
  // background waiting for a shutdown — it is idle, holds no lock, and is present
  // on every healthy box. A `pgrep unattended-upgrade` would match it forever and
  // make this wait ALWAYS time out (a 10-min false stall on every deploy). The
  // locks already catch a genuinely-running upgrade, so locks are all we check.
  const settle = await ssh(
    `for i in $(seq 1 ${Math.floor(SETTLE_WAIT_S / 5)}); do ` +
    `  locked=0; ` +
    `  for lk in /var/lib/dpkg/lock-frontend /var/lib/dpkg/lock /var/lib/apt/lists/lock /var/cache/apt/archives/lock; do ` +
    `    fuser "$lk" >/dev/null 2>&1 && locked=1; ` +
    `  done; ` +
    `  if [ "$locked" = 0 ]; then echo SETTLED; exit 0; fi; ` +
    `  echo "   apt/dpkg lock held — waiting ($i)"; sleep 5; ` +
    `done; echo TIMEOUT`,
    { silent: false, ignoreErrors: true },
  );
  const settled = (settle?.stdout || '').includes('SETTLED');
  if (settled) {
    ok('cloud-init done and apt/dpkg locks free — safe to provision.');
  } else {
    warn(`apt/dpkg lock still held after ${SETTLE_WAIT_S}s.`);
  }
  requireReady('cloud-init finished & apt/dpkg locks free', settled,
    settled ? '' : `dpkg/apt lock still held after ${SETTLE_WAIT_S}s — the box is still provisioning (cloud-init/unattended-upgrades). Wait and re-run.`);
}

// ── Ensure ≥4 GB persistent swap ────────────────────────────────────────────
// The Step-20 crash (Broken pipe during `docker commit`) was an out-of-memory
// reboot: a ~27 GB image plus a docker commit spikes memory, the box had 0 B
// swap, the OOM killer/kernel rebooted it, and the in-progress deploy was lost.
// A swap file is the fix. We provision it BEFORE the heavy image pull/commit so
// the very first deploy on a fresh box is protected, and we make it persistent
// (fstab + swappiness via sysctl.d) so it survives every reboot. Idempotent:
// re-running detects existing swap and only tops up to the 4 GB target.
//
// The whole thing is a single remote bash script (base64-piped so nothing in it
// has to survive shell-quoting through ssh). It never fails the deploy — swap is
// best-effort hardening; if it truly cannot be created we warn and continue.
// --prepare leaves server provisioning to the real deploy (it changes nothing
// that the running deployment depends on).
if (!PREPARE) {
nextStep('Ensuring ≥4 GB persistent swap (prevents OOM during image pull/commit)');
  const SWAP_SCRIPT = `#!/usr/bin/env bash
set -uo pipefail
TARGET_MB=4096
SWAPFILE=/swapfile

active_total_mb() { free -m | awk '/^Swap:/ {print $2}'; }

cur=$(active_total_mb)
# 64 MB slack: a 4096-MiB swapfile reports ~4095 MB via free (mkswap reserves a
# header page), so an exact ">= TARGET" gate would needlessly rebuild an existing
# healthy swapfile on every run. Slack keeps it idempotent.
MIN_OK_MB=$((TARGET_MB - 64))
echo ">>> Current active swap: \${cur} MB (target \${TARGET_MB} MB, accept >= \${MIN_OK_MB} MB)"
if [ "\${cur:-0}" -ge "$MIN_OK_MB" ]; then
  echo ">>> Sufficient swap already active (\${cur} MB >= \${MIN_OK_MB} MB)."
else
  # If our swapfile exists but isn't the right size / not active, rebuild it.
  if [ -f "$SWAPFILE" ]; then
    echo ">>> Existing $SWAPFILE found; ensuring it is active and correctly sized."
    swapoff "$SWAPFILE" 2>/dev/null || true
  fi
  # Disk-space guard: need TARGET + 1 GB headroom on /.
  # Use \`df --output=avail\` (single clean column) instead of \`df -Pm | awk NR==2 {print \$4}\`:
  # for a long root device name (LVM/mapper, e.g. /dev/mapper/ubuntu--vg-ubuntu--lv) df
  # wraps the device onto its own line, so NR==2 is the device and \$4 is empty → the guard
  # would read 0 avail and abort "not enough disk" on a box with plenty of space.
  avail_mb=$(df -BM --output=avail / | tail -1 | tr -dc '0-9')
  need_mb=$((TARGET_MB + 1024))
  if [ "\${avail_mb:-0}" -lt "$need_mb" ]; then
    echo ">>> ERROR: not enough disk for \${TARGET_MB} MB swap (avail \${avail_mb} MB, need \${need_mb} MB)." >&2
    exit 2
  fi
  echo ">>> Creating \${TARGET_MB} MB swap at $SWAPFILE ..."
  rm -f "$SWAPFILE"
  if command -v fallocate >/dev/null 2>&1 && fallocate -l "\${TARGET_MB}M" "$SWAPFILE" 2>/dev/null; then
    :
  else
    echo ">>> fallocate unavailable/failed; using dd (slower)..."
    dd if=/dev/zero of="$SWAPFILE" bs=1M count="$TARGET_MB" status=none
  fi
  chmod 600 "$SWAPFILE"
  mkswap "$SWAPFILE" >/dev/null
  swapon "$SWAPFILE"
  echo ">>> Swap activated."
fi

# Persist across reboots via /etc/fstab (exactly one entry for our swapfile).
if ! grep -qE "^[^#]*[[:space:]]$SWAPFILE[[:space:]]|^$SWAPFILE[[:space:]]" /etc/fstab 2>/dev/null; then
  [ -f /etc/fstab.deploy.bak ] || cp /etc/fstab /etc/fstab.deploy.bak 2>/dev/null || true
  echo "$SWAPFILE none swap sw 0 0" >> /etc/fstab
  echo ">>> Added $SWAPFILE to /etc/fstab (persists across reboots)."
else
  echo ">>> $SWAPFILE already in /etc/fstab."
fi

# Tune swappiness for a mostly-RAM workload, persistently.
mkdir -p /etc/sysctl.d
echo "vm.swappiness=10" > /etc/sysctl.d/99-hive-swap.conf
sysctl -w vm.swappiness=10 >/dev/null 2>&1 || true

echo ">>> Final swap state:"
swapon --show || true
free -h | awk '/^Swap:/ {print "   " $0}'
`;
  const swapB64 = Buffer.from(SWAP_SCRIPT, 'utf8').toString('base64');
  const swapRes = await ssh(
    `echo ${swapB64} | base64 -d > /tmp/hive-swap.sh && bash /tmp/hive-swap.sh; rc=$?; rm -f /tmp/hive-swap.sh; exit $rc`,
    { ignoreErrors: true },
  );
  // A failed script must never be hidden behind the independent probe below
  // (2026-10-07: script hit SSH exit 5, step still printed ✅).
  if (swapRes?.code !== 0) warn(`Swap provisioning script did not complete (exit ${swapRes?.code ?? 'unknown'}); checking current swap state independently.`);
  // Confirm swap is actually active now (independent of the script's own logging).
  const swapMb = await activeSwapMb();
  if (swapMb >= 4000) {
    ok(`Swap active: ${swapMb} MB (persistent via /etc/fstab).`);
  } else if (swapMb > 0) {
    warn(`Swap active but below target: ${swapMb} MB (< 4096 MB). Continuing — deploy may be memory-tight.`);
  } else {
    warn(`Could not confirm active swap (got ${fmtMb(swapMb)}).`);
    if (swapRes?.code) warn(`swap script exit code: ${swapRes.code}`);
  }
  // NOTE: swap is NOT recorded into readiness[] here — the readiness gate re-checks
  // swap LIVE (and again after the reboot), so recording it too would double-report
  // it in the gate summary. readiness[] carries only what the gate does not re-probe
  // (OS, cloud-init/apt settle).
}

// ── BBR congestion control ──────────────────────────────────────────────────
// Root cause of the ~35 KB/s mirror rsync (2026-10-23): the server sends with
// loss-based cubic over a ~300 ms path with ~3% packet loss, so its window
// collapses (ss -ti: cwnd 9, ssthresh 6, 10,639 retransmits) and one stream is
// capped at ~MSS/RTT * 1.22/sqrt(loss) ≈ 32 KB/s. BBR paces by measured bandwidth
// and RTT instead of loss. Ubuntu 24.04 ships tcp_bbr as a module; we load it,
// persist it (modules-load.d + sysctl.d) and switch the default. It only affects
// NEW connections — nothing running is interrupted — so it also runs in --prepare,
// right before the mirror sync that benefits from it.
if (config.tcpBbr && config.cleanTempArchives === 'off') {
  nextStep('Enabling BBR TCP congestion control on the server (fast transfers over a lossy link)');
  const bbr = await ssh(
    `modprobe tcp_bbr 2>/dev/null; ` +
    `if grep -qw bbr /proc/sys/net/ipv4/tcp_available_congestion_control; then ` +
    `  echo tcp_bbr > /etc/modules-load.d/hive-tcp-bbr.conf; ` +
    `  printf 'net.core.default_qdisc=fq\\nnet.ipv4.tcp_congestion_control=bbr\\n' > /etc/sysctl.d/99-hive-tcp-bbr.conf; ` +
    `  sysctl -q -w net.core.default_qdisc=fq net.ipv4.tcp_congestion_control=bbr; ` +
    `fi; sysctl -n net.ipv4.tcp_congestion_control`,
    { silent: true, ignoreErrors: true },
  );
  const cc = (bbr?.stdout || '').trim();
  if (cc === 'bbr') ok('Congestion control: bbr (persistent; applies to new connections).');
  else warn(`Could not enable BBR (congestion control is "${cc || 'unknown'}"); transfers stay loss-limited.`);
}

// ── HARD readiness gate ─────────────────────────────────────────────────────
// Everything above (OS, cloud-init settled, apt idle, swap) recorded a pass/fail
// into `readiness`. Add the last two checks — enough free disk for the ~33 GB
// image, and a stable SSH re-probe — then BLOCK the deploy if anything failed.
// This is the guarantee you asked for: the server is confirmed fully configured
// FIRST, and only a fully-ready box proceeds to backup/install. On a box that is
// still being reinstalled, this aborts with a precise reason instead of pushing a
// half-broken install. `--force-unready` downgrades the block to a warning.
// The pre-reboot gate, mandatory reboot, and post-reboot gate only make sense for
// a REAL deploy. The maintenance modes (--clean-temp-archives, --backup-only) do a
// little work and exit WITHOUT deploying, so they must NOT reboot a production box.
// Skip the whole reboot sequence for them (they run their own steps + exit below).
const IS_MAINTENANCE_RUN = config.cleanTempArchives !== 'off' || BACKUP_ONLY || PREPARE;
if (!IS_MAINTENANCE_RUN) {
// ── Readiness gate #1 (pre-reboot) ──────────────────────────────────────────
// Assert the box is fully provisioned (OS/settle/swap recorded above, + live disk
// & SSH-stability) BEFORE we reboot it. We only reboot a box that is already in
// its final configured state, so the reboot is the last provisioning act, not a
// gamble on a half-installed machine.
await assertReadyGate({ label: 'Readiness gate #1 (pre-reboot): server fully provisioned before rebooting', extra: readiness });

// ── Mandatory reboot ────────────────────────────────────────────────────────
// ALWAYS reboot before deploying (no flag). Reasons:
//   • A freshly (re)installed VPS should be brought up into its FINAL clean state
//     — swap mounted from /etc/fstab, docker started by systemd, cloud-init fully
//     done, kernel/settings applied — rather than deployed onto a transient
//     first-boot environment that is still settling.
//   • It proves, every time, that swap + docker + SSH actually survive a restart
//     (via readiness gate #2 below) BEFORE we invest in a long deploy.
// If the box does not come back, or comes back without swap/docker/SSH, gate #2
// aborts the deploy — we never install onto a box that can't reboot cleanly.
nextStep('Rebooting server into its clean, final state before deploy (always)');
// Probe whether Docker is ALREADY installed before we reboot. If it is (a repeat
// deploy), gate #2 will additionally require the daemon to come back — proving
// docker survives a restart. On a first-ever deploy Docker isn't installed yet, so
// we don't require it post-reboot (it gets installed a few steps later).
const dockerPresentPreReboot = await dockerDaemonUp();
{
  const bootBefore = (await ssh("TZ=UTC uptime -s | sed 's/$/ UTC/'", { silent: true, ignoreErrors: true }))?.stdout?.trim() || '';
  say(`   Boot time before reboot: ${bootBefore || '(unknown)'}`);
  say('   Issuing reboot (SSH will drop; this is expected)...');
  // Reboot SYNCHRONOUSLY — `systemctl reboot` only hands the request to systemd
  // (near-instant); the SSH channel tearing down IS the reboot. Do NOT background
  // it (`... &`): sshd can SIGHUP a backgrounded, TTY-less job before it fires.
  await ssh('nohup systemctl reboot >/dev/null 2>&1 || nohup reboot >/dev/null 2>&1 || shutdown -r now', { ignoreErrors: true });

  // Let it actually go down before we start probing, so we don't "recover" against
  // the still-up pre-reboot sshd.
  say('   Waiting 20s for the server to begin shutting down...');
  await sleep(20000);

  // Wait for SSH to come back with the SAME password (tolerant of the transient
  // cloud-init code-5 window), reusing Step-1's wait policy.
  say('   Waiting for SSH to recover after reboot...');
  const rebootWaitStart = Date.now();
  let rebootBadPassSeen = false;
  for (;;) {
    const probe = await checkSshAvailable();
    if (probe.up) break;
    const elapsed = Date.now() - rebootWaitStart;
    if (probe.badPass) rebootBadPassSeen = true;
    if (elapsed >= SSH_WAIT_MS) {
      fatal(
        rebootBadPassSeen
          ? 'After the pre-deploy reboot, SSH password was rejected for the whole wait window — the password did not survive the reboot. Aborting.'
          : 'After the pre-deploy reboot, the server did not become reachable within the wait window. Aborting.',
      );
    }
    warn(`   SSH not back yet, retrying in 10s [${Math.round(elapsed / 1000)}s/${Math.round(SSH_WAIT_MS / 1000)}s]`);
    await sleep(10000);
  }
  // Confirm the box ACTUALLY rebooted, not just that sshd blipped. `uptime -s` is
  // the boot timestamp; if it is unchanged, SSH recovered against the STILL-UP
  // pre-reboot system (e.g. the reboot was inhibited/deferred by a logind
  // inhibitor, or sshd went down last and we caught the old one). That is a latent
  // FALSE-PASS of the whole point of this step — the post-reboot gate would then
  // "prove" durability against a machine that never restarted. So we RETRY a few
  // times (a genuinely slow reboot just needs more time) and HARD-FAIL if the boot
  // time truly never changes. (If we couldn't read bootBefore at all, we can't make
  // this assertion, so we don't block on it.)
  let bootAfter = (await ssh("TZ=UTC uptime -s | sed 's/$/ UTC/'", { silent: true, ignoreErrors: true }))?.stdout?.trim() || '';
  if (bootBefore) {
    for (let i = 0; i < 6 && bootAfter && bootAfter === bootBefore; i++) {
      warn(`   Boot time still ${bootAfter} — waiting 10s to confirm the reboot actually happened (${i + 1}/6)...`);
      await sleep(10000);
      bootAfter = (await ssh("TZ=UTC uptime -s | sed 's/$/ UTC/'", { silent: true, ignoreErrors: true }))?.stdout?.trim() || bootAfter;
    }
    if (bootAfter && bootAfter === bootBefore) {
      fatal(
        `The server did NOT reboot: boot time is unchanged (${bootAfter}). The reboot was likely inhibited or deferred. ` +
        `Refusing to continue — the mandatory pre-deploy reboot must provably happen (durability of swap/docker across restart is the point). ` +
        `Check for a shutdown inhibitor ('systemd-inhibit --list') and retry.`,
      );
    }
  }
  ok(`   SSH recovered with the same password. New boot time: ${bootAfter || '(unknown)'}`);
  // After a reboot the box may re-enter a brief cloud-init/apt-lock window again;
  // wait for the dpkg/apt locks to free before the post-reboot gate + install.
  say('   Waiting for apt/dpkg locks to free after reboot...');
  await ssh(
    `for i in $(seq 1 60); do ` +
    `  busy=0; for lk in /var/lib/dpkg/lock-frontend /var/lib/dpkg/lock /var/lib/apt/lists/lock /var/cache/apt/archives/lock; do fuser "$lk" >/dev/null 2>&1 && busy=1; done; ` +
    `  [ "$busy" = 0 ] && { echo SETTLED; exit 0; }; sleep 5; ` +
    `done; echo TIMEOUT`,
    { silent: true, ignoreErrors: true },
  );
}

// ── Readiness gate #2 (post-reboot) ─────────────────────────────────────────
// Now PROVE the hardening survived the reboot: swap active (from fstab), disk OK,
// SSH stable — and, IF docker was already installed, that the daemon came back
// (from systemd). This is the real durability check, and it runs on EVERY deploy.
// Abort if anything did not come back. (Docker is only required here when it was
// present pre-reboot; on a first deploy it is installed a few steps below.)
await assertReadyGate({
  label: 'Readiness gate #2 (post-reboot): swap + ssh (and docker, if installed) survived the restart',
  requireDocker: dockerPresentPreReboot,
});
} // end if (!IS_MAINTENANCE_RUN) — reboot sequence skipped for maintenance modes

// Standalone temp-archive cleanup mode: --clean-temp-archives run | dry-run.
// Sweep orphaned artifacts and EXIT without deploying — a safe way to reclaim
// space now (run) or to test the sweep logic (dry-run). Covers BOTH sides:
// remote /tmp backup archives AND incomplete local backup dirs (no MANIFEST).
const CLEAN_TEMP_ARCHIVES = config.cleanTempArchives; // 'off' | 'run' | 'dry-run'
if (CLEAN_TEMP_ARCHIVES !== 'off') {
  const dry = CLEAN_TEMP_ARCHIVES === 'dry-run';
  nextStep(`Temp-archive cleanup (${dry ? 'DRY RUN — listing only' : 'deleting'}) — standalone, no deploy`);
  say('Remote (server /tmp orphaned archives):');
  const swept = await sweepRemoteArchives({ dryRun: dry });
  say('Local (incomplete backup dirs — partial/unverified downloads):');
  const localSwept = sweepLocalPartialBackups({ dryRun: dry });
  const totalBytes = swept.bytes + localSwept.bytes;
  const remoteN = dry ? swept.files.length : swept.removed;
  const localN = dry ? localSwept.dirs.length : localSwept.removed;
  console.log(
    `\n>>> ✅ Temp-archive ${dry ? 'dry run' : 'cleanup'} complete: ` +
    `${dry ? 'would remove' : 'removed'} ${remoteN} remote archive(s) + ${localN} local dir(s), ` +
    `${fmtBytes(totalBytes)} total. No deploy was performed (--clean-temp-archives=${CLEAN_TEMP_ARCHIVES}).`
  );
  process.exit(0);
}

// Startup sweep (normal deploy): reclaim leftovers from a PRIOR run that was
// killed before it could clean up — a remote /tmp archive orphaned between
// create and rm, and/or an incomplete local backup dir (partial download, no
// MANIFEST). Runs on every deploy so a crash is self-healing on the next run.
// --prepare only lists them: another deploy may be running and still writing one.
nextStep(`Sweeping leftovers from prior runs (remote temp archives + incomplete local backups)${PREPARE ? ' — listing only (--prepare)' : ''}`);
await sweepRemoteArchives({ dryRun: PREPARE });
sweepLocalPartialBackups({ dryRun: PREPARE });

// Back up the AI session data BEFORE the deploy touches anything, so we always
// capture the current state. Cleanup (if enabled) runs only after a verified OK.
nextStep('Backing up AI session data (claude/codex) locally');
let backup = { ok: true };
if (SKIP_BACKUP) {
  say(`   --skip-backup set: skipping the AI session-data backup entirely.`);
  warn('Backup SKIPPED — server-side AI session data will NOT be saved locally before deploy.');
  note('Server-side cleanup is forced OFF (we never delete data we did not back up).');
} else {
  say(`⏳ SLOW STEP — backing up valuable AI session data before the deploy touches it.`);
  if (BACKUP_MODE === 'rsync') {
    say(`   Mode: rsync mirror (deltas only, ${config.rsyncCompress === 'zstd' ? 'zstd stream compression' : 'no compression'} — fastest on repeat runs).`);
  } else {
    say(`   Mode: ${BACKUP_MODE} (compress on server, then download over a ~9 MB/s link).`);
  }
  say(`   Server-side bucket cleanup afterwards: ${
    CLEANUP_AI_DATA === 'run' ? 'RUN — empties buckets after a verified backup + per-bucket mirror check'
    : CLEANUP_AI_DATA === 'dry-run' ? 'DRY RUN — shows what would be emptied; deletes nothing'
    : 'OFF (backup only — nothing deleted)'}.`);
  backup = await backupAiData();
  if (!backup.ok) {
    // A failed backup must NOT silently continue into a deploy that could clobber
    // the data — and must never trigger cleanup. Treat it as fatal.
    throw new Error('AI session-data backup failed — aborting before deploy (no data was deleted).');
  }
  if (backup.dir) ok(`Backup complete → ${backup.dir}`);
}

if (CLEANUP_AI_DATA !== 'off') {
  if (backup.dir) {
    const dry = CLEANUP_AI_DATA === 'dry-run';
    nextStep(`${dry ? 'DRY RUN — server-side bucket cleanup (deletes nothing)' : 'Emptying server-side AI-data buckets (backup verified OK)'}`);
    say('Buckets: codex/sessions, codex/generated_images, claude/projects (dirs kept, contents emptied).');
    say('Each bucket is emptied ONLY if the local mirror already contains it (⊇ server).');
    const res = await cleanupServerBuckets(backup, CLEANUP_AI_DATA);
    if (dry) {
      ok(`Dry run: would empty ${res.emptied}/${res.attempted} bucket(s), reclaim ~${fmtBytes(res.reclaimedBytes)} on server; ${res.skipped} skipped by safety gate. Nothing deleted.`);
    } else if (res.emptied === 0 && res.skipped === 0) {
      ok(`Nothing to empty — all ${res.attempted} bucket(s) were already empty or absent on the server.`);
    } else {
      ok(`Emptied ${res.emptied}/${res.attempted} bucket(s), reclaimed ~${fmtBytes(res.reclaimedBytes)} on server (safely backed up to ${backup.dir}); ${res.skipped} skipped by safety gate.`);
    }
  } else {
    note(`--cleanup-ai-data=${CLEANUP_AI_DATA} set but no AI data was present; nothing to clean.`);
  }
} else {
  note('--cleanup-ai-data is off: server-side AI data left in place (backup only).');
}

// Prepare mode: after the mirror sync, pre-pull the image on the server and exit.
// `docker pull` only adds layers and moves the tag; the running hive-mind
// container keeps the image it was created from, so nothing it uses changes. The
// real deploy's "Pulling latest image" step (deploy-docker.mjs) then finds the
// image up to date, which shortens the window in which the bot is down.
if (PREPARE) {
  // Same image choice as deploy-docker.mjs (VARIANTS there; --image wins).
  const prepareImage = config.image
    || (config.imageVariant === 'plain' ? 'konard/hive-mind:latest' : 'konard/hive-mind-dind:latest');
  nextStep(`Pre-pulling ${prepareImage} on the server (running container is not touched)`);
  // The image is ~33 GB; never let a pre-pull fill the disk of a live server.
  const PREPULL_MIN_FREE_GB = 35;
  let pulled = false;
  if (!(await dockerDaemonUp())) {
    warn('Docker is not running on the server; skipping the pre-pull (the real deploy installs/starts it).');
  } else {
    const freeGb = await freeGbOnRoot();
    if (freeGb == null || freeGb < PREPULL_MIN_FREE_GB) {
      warn(`Only ${freeGb ?? '?'} GB free on / (need ≥${PREPULL_MIN_FREE_GB} GB to pre-pull safely); skipping. The real deploy pulls after removing the old container.`);
    } else {
      const pull = await ssh(`docker pull ${prepareImage}`, { ignoreErrors: true });
      pulled = pull?.code === 0;
      if (pulled) ok(/Image is up to date/.test(pull.stdout || '') ? 'Image already up to date on the server.' : 'Newer image downloaded; the real deploy will not download it again.');
      else warn(`docker pull failed (exit ${pull?.code ?? 'unknown'}); the real deploy will pull it.`);
    }
  }
  console.log(
    `\n>>> ✅ Prepare run complete in ${fmtDuration(Date.now() - scriptStartedAt)} total. ` +
    `Nothing was rebooted, deleted, stopped or redeployed (--prepare).`
  );
  if (!SKIP_BACKUP && BACKUP_MODE === 'rsync') console.log('>>>    AI sessions are in the local mirror; the real deploy only transfers what changes from now on.');
  if (pulled) console.log(`>>>    ${prepareImage} is on the server; the real deploy will find it up to date.`);
  console.log('>>>    Run ./deploy-remote-docker.mjs without --prepare to deploy.');
  process.exit(0);
}

// Backup-only mode: we just backed up (and optionally cleaned up) the AI session
// data. Exit BEFORE the deploy steps (Node install, file copy, deploy-docker.mjs).
// With the default rsync mode this has populated the persistent local mirror, so
// a later real deploy transfers only the delta and its backup step is fast —
// the whole point of pre-syncing in advance.
if (BACKUP_ONLY) {
  console.log(
    `\n>>> ✅ Backup-only run complete in ${fmtDuration(Date.now() - scriptStartedAt)} total. ` +
    `No deploy was performed (--backup-only).`
  );
  if (BACKUP_MODE === 'rsync') {
    console.log('>>>    The rsync mirror is now pre-synced; a later real deploy will only transfer the delta.');
  }
  if (backup?.dir) console.log(`>>> 📦 AI session backup saved at: ${backup.dir}`);
  process.exit(0);
}

nextStep('Ensuring Docker (with a running daemon) is installed on server');
// deploy-docker.mjs (run remotely below) assumes a working Docker DAEMON — it
// never installs one, and every one of its steps shells out to `docker ...`.
// On a freshly reinstalled box Docker is usually absent (and Contabo's "Docker"
// image can fail to provision it), so install the LATEST Docker CE from Docker's
// official apt repo, which supports Ubuntu 24.04.
//
// A working `docker` CLI is NOT enough — the daemon must answer. So we gate on
// `docker info` (talks to dockerd), not `docker --version` (client-only). This
// covers the nasty middle case: CLI present but daemon dead/stopped, which the
// old check skipped and left deploy-docker.mjs to fail on later.
const dockerReady = async () => (await ssh('docker info -f "{{.ServerVersion}}"', { silent: true, ignoreErrors: true }))?.code === 0;
const dockerCliVer = async () => (await ssh('docker --version', { silent: true, ignoreErrors: true }))?.stdout?.trim() || '';

if (await dockerReady()) {
  console.log(`>>> Docker already installed and daemon responding: ${await dockerCliVer()}`);
} else {
  const cliVer = await dockerCliVer();
  if (cliVer) {
    // CLI exists but daemon is not responding — try to (re)start it before a
    // full reinstall, since a stopped service is the common cause on fresh boxes.
    console.log(`>>> Docker CLI present (${cliVer}) but daemon not responding — starting docker service...`);
    await ssh('systemctl enable --now docker', { ignoreErrors: true });
  }
  if (!(await dockerReady())) {
    console.log('>>> Installing the latest Docker CE from Docker\'s official apt repo...');
    // Prereqs + Docker's GPG key (idempotent; --yes overwrites a stale key).
    await apt('update -y');
    await apt('install -y ca-certificates curl gnupg');
    await ssh('install -m 0755 -d /etc/apt/keyrings');
    await ssh('curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor --yes -o /etc/apt/keyrings/docker.gpg');
    await ssh('chmod a+r /etc/apt/keyrings/docker.gpg');
    // Pin the repo to THIS box's codename (noble for 24.04) so we always get the
    // build matching the OS rather than hardcoding a release name.
    await ssh(
      'echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] ' +
      'https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" ' +
      '> /etc/apt/sources.list.d/docker.list',
    );
    await apt('update -y');
    await apt('install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin');
    // Make sure the daemon is up and survives reboots before anything calls it.
    await ssh('systemctl enable --now docker');
  }
  // Final gate: the daemon MUST answer now, or nothing downstream can work.
  const daemonVerify = await ssh('docker info -f "{{.ServerVersion}}"', { ignoreErrors: true });
  if (!daemonVerify || daemonVerify.code !== 0) {
    fatal('Docker is installed but the daemon is not responding (docker info failed). Cannot continue.', daemonVerify);
  }
  console.log(`>>> Docker ready: ${await dockerCliVer()} (daemon ${daemonVerify.stdout.trim()})`);
}

// ── Ensure Docker survives reboot ───────────────────────────────────────────
// The daemon answering NOW is not the same as it coming back after a reboot or
// crash. The bot container runs with `--restart unless-stopped`, but that only
// helps if dockerd itself auto-starts on boot. So assert both docker and
// containerd are systemd-enabled (enable them if not). Without this, a reboot
// (e.g. the OOM we just guarded against, or a Contabo maintenance restart) would
// leave the daemon — and therefore the bot — down until the next manual deploy.
for (const unit of ['containerd', 'docker']) {
  const en = (await ssh(`systemctl is-enabled ${unit} 2>/dev/null || true`, { silent: true, ignoreErrors: true }))?.stdout?.trim() || '';
  // `static` and `alias` both auto-start on boot without an [Install] section:
  // containerd.io ships containerd.service as `static`, pulled in by docker.service's
  // `Requires=`. Treating those as "needs enabling" would run `systemctl enable` (which
  // fails on a static unit) and emit a scary — but false — warning on a healthy box.
  const bootOk = en === 'enabled' || en === 'static' || en === 'alias';
  if (bootOk) {
    console.log(`>>> ${unit}.service is "${en}" (will auto-start on boot).`);
  } else {
    console.log(`>>> ${unit}.service is "${en || 'not-enabled'}" — enabling for boot survival...`);
    await ssh(`systemctl enable ${unit}`, { ignoreErrors: true });
    const en2 = (await ssh(`systemctl is-enabled ${unit} 2>/dev/null || true`, { silent: true, ignoreErrors: true }))?.stdout?.trim() || '';
    if (en2 === 'enabled' || en2 === 'static' || en2 === 'alias') console.log(`>>> ${unit}.service now "${en2}" (auto-starts on boot).`);
    else warn(`Could not enable ${unit}.service (is-enabled="${en2}"); Docker may not auto-start after a reboot.`);
  }
}

// ── Keep containers running when dockerd restarts (live-restore) ────────────
// Without live-restore, every dockerd restart (crash, OOM kill, package
// upgrade) SIGKILLs every container on restore. On 2026-10-09 the kernel
// OOM-killed dockerd, and its restart took down the bot container and all
// running task containers at once. With "live-restore": true they keep running
// and dockerd re-attaches to them. The option is reloadable, so it is applied
// with SIGHUP (`systemctl reload docker`); a restart here would itself kill
// every container. Other keys in daemon.json are kept; an unparsable file is
// left alone and reported.
const mergeLiveRestore = `python3 -c 'import json,os
p="/etc/docker/daemon.json"
d=json.load(open(p)) if os.path.exists(p) and os.path.getsize(p) else {}
changed=d.get("live-restore") is not True
d["live-restore"]=True
os.makedirs("/etc/docker",exist_ok=True)
changed and open(p,"w").write(json.dumps(d,indent=2)+"\\n")
print("changed" if changed else "unchanged")'`;
const liveRestoreEnabled = async () => (await ssh(`docker info -f '{{.LiveRestoreEnabled}}'`, { silent: true, ignoreErrors: true }))?.stdout?.trim() === 'true';
if (await liveRestoreEnabled()) {
  console.log('>>> Docker live-restore is enabled (containers survive a dockerd restart).');
} else {
  const merged = await ssh(mergeLiveRestore, { ignoreErrors: true });
  if (!merged || merged.code !== 0) {
    warn(`Could not set "live-restore": true in /etc/docker/daemon.json (is it valid JSON?): ${(merged?.stderr || '').trim()}`);
  } else {
    await ssh('systemctl reload docker', { ignoreErrors: true });
    if (await liveRestoreEnabled()) console.log('>>> Docker live-restore enabled via reload (no container was restarted).');
    else warn('live-restore is set in /etc/docker/daemon.json but dockerd did not pick it up on reload; it applies after the next dockerd start.');
  }
}

nextStep('Ensuring Node.js 20+ with npm is installed on server');
const nodeCheck = await ssh('node --version', { ignoreErrors: true });
const nodeVersion = nodeCheck?.stdout?.trim();
const nodeMajor = nodeVersion ? parseInt(nodeVersion.replace('v', ''), 10) : 0;
const npmCheck = await ssh('npm --version', { ignoreErrors: true });
const hasNpm = npmCheck && npmCheck.code === 0;

if (nodeMajor >= 20 && hasNpm) {
  console.log(`>>> Node.js already installed: ${nodeVersion}, npm: ${npmCheck.stdout.trim()}`);
} else {
  console.log(`>>> Node.js ${nodeMajor >= 20 ? 'found but npm missing' : 'not found or too old'}. Installing Node.js 20 via NodeSource...`);
  await apt('update -y');
  await apt('install -y ca-certificates curl gnupg');
  await ssh('mkdir -p /etc/apt/keyrings && curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg');
  await ssh('echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_20.x nodistro main" > /etc/apt/sources.list.d/nodesource.list');
  await apt('update -y');
  await apt('install -y nodejs');
  const nodeVerify = await ssh('node --version');
  const npmVerify = await ssh('npm --version');
  console.log(`>>> Node.js installed: ${nodeVerify.stdout.trim()}, npm: ${npmVerify.stdout.trim()}`);
}

nextStep('Creating remote directory');
await ssh(`mkdir -p ${REMOTE_DIR}`);

// Remove the file under its old name from prior deploys (the script was
// renamed: docker-restart-locally.mjs -> deploy-docker.mjs).
await ssh(`rm -f ${REMOTE_DIR}/docker-restart-locally.mjs`, { ignoreErrors: true });

nextStep('Copying files to server');
await scp(resolve(__dirname, 'deploy-docker.mjs'), `${REMOTE_DIR}/deploy-docker.mjs`);
await scp(resolve(__dirname, '.lenv'), `${REMOTE_DIR}/.lenv`);

nextStep('Making script executable');
await ssh(`chmod +x ${REMOTE_DIR}/deploy-docker.mjs`);

// ── Resume-safety: kill any orphaned remote deploy from an interrupted run ───
// If a previous `deploy-remote-docker.mjs` was interrupted (Ctrl-C locally, a
// dropped SSH connection, a laptop sleep), the REMOTE `node deploy-docker.mjs`
// it launched keeps running on the server — SSH does not reliably signal it on
// client disconnect. That orphan races THIS run: it re-creates / pauses the
// `hive-mind` container between our cleanup and our `docker run`, producing the
// "container name already in use" conflict that makes a restart fail to resume.
// So before we launch a fresh deploy, terminate any prior deploy-docker.mjs
// process (and give it a moment to release the container), so our run starts
// from a clean, uncontended state. pkill returns nonzero when nothing matched,
// which is fine — ignoreErrors.
nextStep('Killing any orphaned deploy-docker.mjs from a prior interrupted run');
const orphanCheck = await ssh(
  "pgrep -af 'node .*deploy-docker\\.mjs' || echo '(none)'",
  { silent: true, ignoreErrors: true },
);
const orphanList = (orphanCheck?.stdout || '').trim();
if (orphanList && orphanList !== '(none)') {
  warn(`Found orphaned remote deploy process(es), terminating:\n   ${orphanList.split('\n').join('\n   ')}`);
  // TERM first, then wait, then KILL survivors. Then wait for the process table
  // to actually clear so its container operations have fully ceased.
  await ssh("pkill -TERM -f 'node .*deploy-docker\\.mjs'", { ignoreErrors: true });
  await ssh(
    "for i in $(seq 1 10); do pgrep -f 'node .*deploy-docker\\.mjs' >/dev/null 2>&1 || break; sleep 1; done; " +
    "pkill -KILL -f 'node .*deploy-docker\\.mjs' 2>/dev/null; true",
    { ignoreErrors: true },
  );
  ok('Orphaned remote deploy process(es) terminated.');
} else {
  note('No orphaned deploy-docker.mjs process running — clean to proceed.');
}

nextStep('Running deploy-docker.mjs on server');
console.log('>>> ⏳ This is the long step: the remote script pulls/updates the ~33 GB image,');
console.log('>>>    rebuilds the bot container, and waits for it to start. Its own Step N: lines');
console.log('>>>    stream below in real time. Expect several minutes; no output gap = it is working.');
const remoteArgs = [
  `--image-variant ${config.imageVariant}`,
  `--isolation-mode ${config.isolationMode}`,
  config.image ? `--image ${config.image}` : '',
  config.resetDocker ? '--reset-docker' : '',
  config.keepInactiveVariant ? '--keep-inactive-variant' : '',
  config.interactiveLogin ? '--interactive-login' : '',
  config.mtproxy ? '--mtproxy' : '',
  config.mtproxyUpdate ? '--mtproxy-update' : '',
  config.verifyMtproxy ? '--verify-mtproxy' : '',
  config.mtproxy ? `--mtproxy-engine ${MTPROXY_ENGINE}` : '',
  config.mtproxy ? `--mtproxy-port ${MTPROXY_PORT}` : '',
  config.mtproxyMss ? `--mtproxy-mss ${JSON.stringify(config.mtproxyMss)}` : '',
  config.mtproxyImage ? `--mtproxy-image ${JSON.stringify(config.mtproxyImage)}` : '',
  config.mtproxyClassicImage ? `--mtproxy-classic-image ${JSON.stringify(config.mtproxyClassicImage)}` : '',
  config.mtproxyFrontingHost ? `--mtproxy-fronting-host ${JSON.stringify(config.mtproxyFrontingHost)}` : '',
].filter(Boolean).join(' ');
// Run the remote deploy with a pseudo-TTY (ssh -tt). Without a TTY, sshd does
// NOT reliably signal the remote node process when this ssh client goes away
// (Ctrl-C, dropped link, laptop sleep) — the deploy then keeps running as an
// orphan and collides with the next attempt (the failure that broke the last
// resume). A TTY makes sshd deliver SIGHUP to the remote process group on
// disconnect, so the deploy dies WITH its ssh session. We also belt-and-braces
// kill any orphan at the START of every run (step above), so both the cause and
// any residue are handled. `-tt` forces TTY allocation even though our stdin is
// not itself a terminal; command-stream still streams the combined output live.
await sshTTY(`cd ${REMOTE_DIR} && exec node deploy-docker.mjs ${remoteArgs}`);

// ── EXTRA post-deploy durability proof (--verify-reboot) ────────────────────
// The deploy ALWAYS reboots BEFORE installing (gates #1/#2 above), so ssh + swap +
// docker durability is already proven every run. This OPTIONAL second reboot runs
// AFTER the deploy to additionally prove the hive-mind bot CONTAINER auto-restarts
// (restart policy unless-stopped) — the only thing the pre-deploy reboot cannot
// check, because the container does not exist until the deploy creates it.
if (config.verifyReboot) {
  nextStep('EXTRA post-deploy reboot: verifying the bot container auto-restarts (ssh + swap + docker + container)');
  // Snapshot boot time so we can confirm the box actually rebooted (not just that
  // sshd blipped). `who -b` / `uptime -s` gives the last boot timestamp.
  const bootBefore = (await ssh("TZ=UTC uptime -s | sed 's/$/ UTC/'", { silent: true, ignoreErrors: true }))?.stdout?.trim() || '';
  say(`   Boot time before reboot: ${bootBefore || '(unknown)'}`);
  say('   Issuing reboot (SSH will drop; this is expected)...');
  // Reboot SYNCHRONOUSLY: `systemctl reboot` only needs to hand the request to
  // systemd/logind (near-instant) — the SSH channel tearing down IS the reboot.
  // Do NOT background it (`... &`): a backgrounded, non-nohup'd job with no TTY can
  // be SIGHUP'd when sshd closes the channel, killing it before it reboots, so the
  // box would silently stay up and we'd "verify" against the un-rebooted system.
  // `ignoreErrors` swallows the expected torn-down/non-zero exit as the link drops.
  await ssh('nohup systemctl reboot >/dev/null 2>&1 || nohup reboot >/dev/null 2>&1 || shutdown -r now', { ignoreErrors: true });

  // Give it a moment to actually go down, so we don't "succeed" against the
  // still-up pre-reboot sshd.
  say('   Waiting 20s for the server to begin shutting down...');
  await sleep(20000);

  // Wait for SSH to come back with the SAME password — reuse the exact tolerant
  // loop policy from Step 1 (transient code 5 during cloud-init is retried).
  say('   Waiting for SSH to recover after reboot...');
  const rebootWaitStart = Date.now();
  let rebootBadPassSeen = false;
  for (;;) {
    const probe = await checkSshAvailable();
    if (probe.up) break;
    const elapsed = Date.now() - rebootWaitStart;
    if (probe.badPass) rebootBadPassSeen = true;
    if (elapsed >= SSH_WAIT_MS) {
      fatal(
        rebootBadPassSeen
          ? 'After reboot, SSH password was rejected for the whole wait window — the password did NOT survive the reboot.'
          : 'After reboot, the server did not become reachable within the wait window.',
      );
    }
    warn(`   SSH not back yet, retrying in 10s [${Math.round(elapsed / 1000)}s/${Math.round(SSH_WAIT_MS / 1000)}s]`);
    await sleep(10000);
  }
  // Same as the mandatory reboot: confirm the box actually restarted (retry for a
  // slow reboot, hard-fail if the boot time truly never changes) — the whole point
  // of --verify-reboot is to PROVE durability across a real restart.
  let bootAfter = (await ssh("TZ=UTC uptime -s | sed 's/$/ UTC/'", { silent: true, ignoreErrors: true }))?.stdout?.trim() || '';
  if (bootBefore) {
    for (let i = 0; i < 6 && bootAfter && bootAfter === bootBefore; i++) {
      warn(`   Boot time still ${bootAfter} — waiting 10s to confirm the reboot happened (${i + 1}/6)...`);
      await sleep(10000);
      bootAfter = (await ssh("TZ=UTC uptime -s | sed 's/$/ UTC/'", { silent: true, ignoreErrors: true }))?.stdout?.trim() || bootAfter;
    }
    if (bootAfter && bootAfter === bootBefore) {
      fatal(`--verify-reboot: the server did NOT reboot (boot time unchanged: ${bootAfter}). Reboot likely inhibited/deferred; cannot verify durability.`);
    }
  }
  ok(`   SSH recovered with the same password. New boot time: ${bootAfter || '(unknown)'}`);

  // Now assert every piece of the hardening survived the reboot.
  const checks = [];
  // 1) Swap active + persisted.
  const swapMb = await activeSwapMb();
  // Anchor to the actual /swapfile mount line — a loose grep for "swap" would also
  // match a comment or an unrelated entry and falsely report "persisted".
  const swapInFstab = (await ssh(`grep -qE '(^|[[:space:]])/swapfile[[:space:]]' /etc/fstab && echo yes || echo no`, { silent: true, ignoreErrors: true }))?.stdout?.trim() === 'yes';
  checks.push({ name: `swap active ≥4 GB (${fmtMb(swapMb)})`, ok: swapMb != null && swapMb >= 4000 });
  checks.push({ name: 'swap persisted in /etc/fstab', ok: swapInFstab });
  // 2) Docker daemon up + enabled.
  const dockerUp = (await ssh('docker info -f "{{.ServerVersion}}"', { silent: true, ignoreErrors: true }))?.code === 0;
  const dockerEnabled = (await ssh('systemctl is-enabled docker 2>/dev/null || true', { silent: true, ignoreErrors: true }))?.stdout?.trim() === 'enabled';
  checks.push({ name: 'docker daemon responding after reboot', ok: dockerUp });
  checks.push({ name: 'docker.service enabled (auto-start on boot)', ok: dockerEnabled });
  // 3) Bot container came back with restart policy.
  const botStatus = (await ssh(`docker inspect -f '{{.State.Status}}' hive-mind 2>/dev/null || echo missing`, { silent: true, ignoreErrors: true }))?.stdout?.trim() || 'missing';
  const botPolicy = (await ssh(`docker inspect -f '{{.HostConfig.RestartPolicy.Name}}' hive-mind 2>/dev/null || echo none`, { silent: true, ignoreErrors: true }))?.stdout?.trim() || 'none';
  checks.push({ name: `hive-mind container running (status=${botStatus})`, ok: botStatus === 'running' });
  checks.push({ name: `hive-mind restart policy = unless-stopped (is: ${botPolicy})`, ok: botPolicy === 'unless-stopped' });
  // 4) MTProto proxy (only when this deploy requested it).
  if (config.mtproxy) {
    const proxyStatus = (await ssh(`docker inspect -f '{{.State.Status}}' ${MTPROXY_CONTAINER} 2>/dev/null || echo missing`, { silent: true, ignoreErrors: true }))?.stdout?.trim() || 'missing';
    const proxyPolicy = (await ssh(`docker inspect -f '{{.HostConfig.RestartPolicy.Name}}' ${MTPROXY_CONTAINER} 2>/dev/null || echo none`, { silent: true, ignoreErrors: true }))?.stdout?.trim() || 'none';
    checks.push({ name: `${MTPROXY_CONTAINER} container running (status=${proxyStatus})`, ok: proxyStatus === 'running' });
    checks.push({ name: `${MTPROXY_CONTAINER} restart policy = unless-stopped (is: ${proxyPolicy})`, ok: proxyPolicy === 'unless-stopped' });
  }

  say('   Post-reboot durability checks:');
  for (const c of checks) say(`     ${c.ok ? '✅' : '❌'} ${c.name}`);
  const failed = checks.filter((c) => !c.ok);
  if (failed.length) {
    fatal(`Durability verification FAILED after reboot: ${failed.map((c) => c.name).join('; ')}.`);
  }
  ok('Durability verified: ssh, swap, docker, and the bot container all survived a reboot.');
}

console.log(`\n>>> ✅ Deploy complete in ${fmtDuration(Date.now() - scriptStartedAt)} total.`);
if (backup?.dir) console.log(`>>> 📦 AI session backup saved at: ${backup.dir}`);

} catch (err) {
  fatal('Deploy failed:', err);
}
