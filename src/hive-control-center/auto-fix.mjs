#!/usr/bin/env node

// Bring the server back after a crash (Docker daemon OOM-killed, host reboot,
// hive-mind container stopped) and get the interrupted work running again.
//
// What it does, in order:
//   1. Waits for SSH, then prints what killed things (kernel OOM kills, docker
//      daemon restarts, container exit codes) and what uses the CPU now
//      (auto-fix/cpu.mjs: load, top processes, every container with the time
//      its threads waited for a CPU, task URLs, and busy-loop "hogs" such as
//      a stuck Formal AI sidecar, each sampled again: its busy thread, its
//      system calls, and the program blocked writing to it because it stopped
//      reading, e.g. the Claude session of a stuck solve). Also reports stuck
//      gh-upload-log/sanitizer processes (auto-fix/stuck-uploads.mjs: age,
//      lifetime CPU, read/write fd offsets sampled twice, and the first
//      netrc-like `default` line that triggers the quadratic sanitizer scan).
//      Read-only unless --kill-stuck-uploads is given.
//   2. Starts the Docker daemon if it is not active, and turns on Docker
//      live-restore with a reload (never a restart) when it is off, so the
//      next dockerd restart does not kill every container (--no-fix-live-restore).
//   3. Starts the existing `hive-mind` container. It is never removed or
//      recreated: the bot's state, the start-command execution store and the
//      task logs live in its writable layer.
//   4. Waits for the bot to poll Telegram again.
//      Before recovery, removes server-global Claude/Codex add-ons: plugins,
//      user skills, hooks, global instructions and non-Playwright MCPs. Auth,
//      conversations and stock CLI system skills stay; quarantine is root-only
//      outside tool discovery. Rechecked on every monitor poll. --diagnose is
//      report-only; --global-tools-only runs just this check/repair, and
//      --no-fix-global-tools reports without changing anything.
//      Also stops recognized idle tool services before recovery and on each
//      monitor poll. Codex managed app-server/updater and orphan Claude browser
//      helpers are guarded by active-task, foreground-process and PID-identity
//      checks. --tool-services-only --service-tools codex runs just that cleanup;
//      --no-stop-idle-tool-services or --dry-run audits without signals.
//   5. Rebuilds the solve queue the bot had in memory from the container log
//      (every `Enqueued` minus every `Starting`/`Cancelled`/`Rejected`) and
//      writes the original Telegram commands of the lost items to
//      data/recovered-queue-<time>.txt, ready to paste back into the chat.
//   6. Lists Claude Code sessions that were active in the root container.
//   7. Repairs start-command's execution store (auto-fix/repair-records.mjs):
//      removes a dead 0-byte lock left by a full disk (it blocks every write,
//      link-foundation/start#193), rewrites the record of a running container
//      that `$ --resume` could not save, and attaches start-command's own
//      completion watcher to every running task container without one, so
//      each task is finalized and cleaned up even when the bot no longer
//      watches it (--no-repair-records only reports).
//   8. Reports dead tasks to link-assistant/hive-mind (auto-fix/report.mjs,
//      with host facts from auto-fix/host-facts.mjs), before anything is
//      cleaned up: killed (exit >= 128, OOM), program not found (127), lost
//      (record executing, nothing running), failed recovery runs, and any
//      other non-zero exit (--no-report-failed skips those). Attempts that
//      ended in the last --since-hours are checked, and every dead task
//      container still on disk however old it is. Each
//      attempt is checked with `$ --list`/`$ --status`: its log tail, recovery
//      and lifecycle lines, memory lines, Docker's own log (is the log
//      complete?), the kernel OOM and dockerd restart lines around its exit,
//      its writable-layer size, memory limit, uncommitted and unpushed Git
//      work (a stopped container is mounted read-only, never started),
//      whether a later attempt recovered it, and the bot log lines for it.
//      One issue or comment per failure signature; known issues get comments
//      (a closed one gets a new issue that references it). Already reported
//      attempts are skipped: a state file in the bot container and a GitHub
//      search for the execution UUID. Logs, and the bot log once per run, are
//      uploaded private: execution logs with `$ --upload-log` (start-command
//      0.37+ sanitizes them), the bot log with hive-mind's sanitizing
//      uploader; every body passes hive-mind's fail-closed publication
//      sanitizer. --report-dry writes previews instead.
//   9. Resumes every killed task container from start-command's execution
//      store (`$ --list`), which survives everything: `$ --resume <execution>
//      -- solve <original args> --resume <last tool session id>` commits the
//      stopped container and continues the same work in `<session>-resume-N`.
//      The resume command is built with hive-mind's own helpers. Tasks the bot
//      is still recovering by itself get --bot-grace-minutes first; a resume
//      the bot started with a Telegram alias as the program (`/codex ...`,
//      exit 127) is redone with `solve`. Snapshots of full task layers run one
//      at a time, smallest first, and only when free disk is at least 1.5x the
//      layer (compressed blob + unpacked copy) plus --snapshot-headroom-gb.
//      Once a resumed container runs, the stopped containers it was committed
//      from are removed: their whole filesystem is in its image.
//  10. Cleans up executions that finished properly (exit 0), before and after
//      recovery: their stopped containers and the `start-command-resume/*`
//      snapshot images they were resumed from (tens of GB per task). A failed
//      execution is cleaned up the same way once every dead attempt of it is
//      reported and no Git work dir in its containers holds uncommitted or
//      unpushed work (checked on a read-only mount); otherwise it is kept and
//      the reason printed. A killed task that is still to be resumed (exit
//      137 or the alias 127, under --max-resumes, not superseded) always keeps
//      its container. Its start-command record and log always stay.
//  11. Monitors until every task runs again, printing disk, memory, dockerd
//      RSS, load and the top CPU users on every poll, with a warning for each
//      CPU hog (--cpu-hog-percent, --cpu-hog-minutes; never stopped), checks
//      stuck gh-upload-log/sanitizer processes (--stuck-upload-minutes,
//      --stuck-upload-percent; killed only with --kill-stuck-uploads), and
//      checks the tasks for stuck work (auto-fix/tasks.mjs, also run once
//      with the CPU sample of the failure diagnosis): a Playwright browser that burns at
//      least --browser-busy-cores while unused is killed (the browser only,
//      never the AI session; --no-kill-stuck-browsers reports only) when
//      Claude's own session transcript (real time, unlike the start-command
//      log, which gets the stream-json in late chunks) confirms it: the call
//      that launched it, none pending, and the session moved on (3 other tool
//      calls since the last browser result and --browser-idle-minutes passed,
//      or --browser-max-idle-minutes whatever happened); the container has one
//      @playwright/mcp >= 0.0.83, which launches a new browser on its next call. A detached
//      browser (its Playwright launcher exited, nothing holds the pipe that
//      drives it) and orphaned Chrome child processes (their browser process
//      exited) are killed without a log check: nothing can use them. A Formal AI
//      client that waits for a stopped sidecar or is resumed again and again
//      by Hive Mind is reported (a sidecar restart or stop ends neither).
//      With --follow (the default) it keeps following the
//      running tasks the bot does not track (resumed or adopted here) until
//      they end: one that died is reported, one that finished is cleaned up.
//      --wait-minutes bounds it; a later run picks up where it stopped.
//  12. Safe disk cleanup with disk-space-saviour (auto-fix/disk-clean.mjs,
//      pinned and integrity-checked): the host with Docker storage excluded,
//      then each running container (scanned inside, measured and deleted only
//      where its writable layer really holds the bytes), then the journal
//      vacuumed to --journal-keep-days. dss is never pointed at Docker itself:
//      its `docker diff` storm is what got dockerd OOM-killed on 2026-10-09.
//      A guard stops it when dockerd or the host runs short of memory.
//
// Diagnosis only (--diagnose, read-only, nothing else runs): what uses the
// machine right now and on whose behalf (auto-fix/diagnose.mjs). Over one
// --diagnose-seconds window: machine CPU (busy cores, not the load average),
// CPU/memory/I/O waits, memory, disk, network, forks; then every container and
// service by cgroup (exited processes included) adding up to the machine total,
// each task with its URL, tool, model, start-command execution and the
// Telegram user who requested it, the Formal AI sidecar with the tasks
// connected to it; inside each container the CPU by what it is (Telegram bot,
// its finished commands, start-command monitor loops per task, task
// processes), the top processes with own and finished-children CPU, start
// time, memory and how each was started (parent chain, docker run or docker
// exec), what was started during the window and by whom, unreaped zombies,
// and possible busy loops; the CPU state of every container, the ones a
// task's own Docker daemon runs inside it too (user/system, time waiting for
// a CPU, throttling, process states); each busy process sampled again (busy
// thread, system calls, a program blocked writing to it); blocked output in
// every container, busy or not (a reader that leaves a writer's output
// unread, e.g. a solve that stalls its Claude session); the biggest CPU users
// since they started; then the task check above, report only (no browser is
// killed). It starts with IN SHORT, the findings in plain words, and SINCE
// THE LAST DIAGNOSIS: tasks that started or ended and the CPU each
// long-running process used in between, from the previous
// data/diagnose-<time>.json. Written to data/diagnose-<time>.json too.
//
// Safe to run again at any time. A task is resumed only while it is still the
// interrupted work: never when its execution (or any of its snapshot
// containers) is running or being resumed, when a newer execution of the same
// issue/PR finished with exit 0, or after --max-resumes resumes. Only one run
// acts at a time (a lock inside the container); a second run just reports.
//
// Tasks resumed by this script are not tracked by the bot, so it does not post
// a Telegram completion message for them; the solver still reports on GitHub.
// Once hive-mind recovers its queue and tasks by itself after a root container
// restart, steps 5 and 9 can go.
//
// Usage: ./auto-fix.mjs [--verbose] [--since-hours 24] [--wait-minutes 240]
//        [--poll-seconds 60] [--bot-grace-minutes 10] [--max-resumes 3]
//        [--no-resume] [--no-cleanup] [--no-repair-records] [--no-follow]
//        [--no-report] [--report-dry] [--no-report-failed] [--max-reports 5]
//        [--report-repo link-assistant/hive-mind] [--public-logs]
//        [--no-dss-clean] [--dss-dry] [--journal-keep-days 3]
//        [--no-fix-live-restore] [--cpu-hog-percent 90] [--cpu-hog-minutes 30]
//        [--stuck-upload-minutes 30] [--stuck-upload-percent 80]
//        [--kill-stuck-uploads] [--check-uploads]
//        [--no-kill-stuck-browsers] [--browser-idle-minutes 5]
//        [--browser-max-idle-minutes 30] [--browser-busy-cores 0.5]
//        [--collect <uuid|session>...] [--collect-matching <pattern>]
//        [--update-dependency <name>...] [--update-all-dependencies]
//        [--diagnose] [--diagnose-seconds 15] [--check-tasks] [--dry-run]
//        [--global-tools-only] [--no-fix-global-tools]
//   Clean only server-global tool add-ons: ./auto-fix.mjs --global-tools-only
//   Audit only (exit 1 if dirty): ./auto-fix.mjs --global-tools-only --dry-run
//   Remove explicitly preserved failed containers with hive-cleanup only:
//     ./auto-fix.mjs --cleanup-failed data/cleanup-preservation-receipt.json
//     (add --dry-run to preview; requires a verified complete-layer backup)
//   Remove every stopped failed task container with hive-cleanup, keeping every
//   task that still has a running container (no preservation backup):
//     ./auto-fix.mjs --cleanup-all-failed   (add --dry-run to preview)
//   Diagnose resource use, change nothing: ./auto-fix.mjs --diagnose
//   Report where disk space is used, change nothing: ./auto-fix.mjs --disk-report
//   Only the stuck upload check (gh-upload-log/sanitizer; report only):
//     ./auto-fix.mjs --check-uploads
//   Kill uploads confirmed stuck (no file progress, a core for 30+ min):
//     ./auto-fix.mjs --check-uploads --kill-stuck-uploads
//   Only the task check (kills unused browsers as above, nothing else runs):
//     ./auto-fix.mjs --check-tasks   (add --no-kill-stuck-browsers to only report)
//   Update one global dependency (preview first):
//     ./auto-fix.mjs --update-dependency gh-upload-log --dry-run
//     ./auto-fix.mjs --update-dependency gh-upload-log
//   Update every global dependency (preview first):
//     ./auto-fix.mjs --update-all-dependencies --dry-run
//     ./auto-fix.mjs --update-all-dependencies
//   Collect runs (successful ones too), change nothing else:
//     ./auto-fix.mjs --collect <uuid> ...   or   --collect-matching formal-ai
//   Change nothing anywhere, show what would happen: ./auto-fix.mjs --dry-run
//     (also with --check-tasks: which browsers would be killed and why not)
//   Report only, change nothing: ./auto-fix.mjs --no-resume --no-cleanup
//     --no-repair-records --report-dry --dss-dry --no-fix-live-restore --no-follow
//     --no-kill-stuck-browsers --no-fix-global-tools

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
  const { lstatSync, existsSync, readlinkSync, unlinkSync } =
    await import('node:fs');
  const { join } = await import('node:path');
  try {
    const prefix = execSync('npm prefix -g', { encoding: 'utf8' }).trim();
    const bin = join(
      prefix,
      process.platform === 'win32' ? '' : 'bin',
      'command-stream'
    );
    if (
      lstatSync(bin).isSymbolicLink() &&
      !existsSync(bin) &&
      readlinkSync(bin).includes('command-stream-v-')
    ) {
      unlinkSync(bin);
    }
  } catch {}
})();

const { $ } = await use('command-stream@1.6.2');
const { makeConfig } = await use('lino-arguments@0.3.0');
const fs = await import('node:fs');

const config = makeConfig({
  yargs: ({ yargs, getenv }) =>
    yargs
      .version(false)
      .help(false)
      .option('server-ip', { default: getenv('SERVER_IP') })
      .option('server-user', { default: getenv('SERVER_USER') })
      .option('server-pass', { default: getenv('SERVER_PASS') })
      .option('since-hours', {
        type: 'number',
        default: 24,
        description: 'How far back to look for the failure and killed tasks',
      })
      .option('wait-minutes', {
        type: 'number',
        default: 240,
        description: 'How long to monitor task recovery',
      })
      .option('poll-seconds', {
        type: 'number',
        default: 60,
        description: 'Interval between recovery polls',
      })
      .option('resume', {
        type: 'boolean',
        default: true,
        description: 'Resume killed tasks (--no-resume only reports)',
      })
      .option('cleanup', {
        type: 'boolean',
        default: true,
        description:
          'Remove containers and snapshot images of executions that finished with exit 0, and of failed ones once reported with no unsaved Git work (--no-cleanup keeps them)',
      })
      .option('cleanup-failed', {
        type: 'string',
        description:
          'Only run hive-cleanup for the stopped failed containers in this verified preservation receipt; --dry-run previews, other recovery/reporting/cleanup steps do not run',
      })
      .option('cleanup-all-failed', {
        type: 'boolean',
        default: false,
        description:
          'Only run hive-cleanup for every stopped failed task container, keeping tasks that still have a running container; no preservation backup, other recovery/reporting/cleanup steps do not run',
      })
      .option('max-resumes', {
        type: 'number',
        default: 3,
        description:
          'Never resume an execution that was already resumed this many times',
      })
      .option('bot-grace-minutes', {
        type: 'number',
        default: 10,
        description: 'Time the bot gets to recover a task it tracks',
      })
      .option('snapshot-headroom-gb', {
        type: 'number',
        default: 5,
        description:
          'Free disk to keep beyond 1.5x the layer being snapshotted',
      })
      .option('min-free-gb', {
        type: 'number',
        default: 10,
        description: 'Warn when free disk drops below this',
      })
      .option('max-dockerd-rss-gb', {
        type: 'number',
        default: 4,
        description: 'Warn when dockerd memory exceeds this',
      })
      .option('cpu-hog-percent', {
        type: 'number',
        default: 90,
        description:
          'Warn about a process that uses this much of one core now and has averaged 80% over at least --cpu-hog-minutes (a busy loop; reported, never stopped)',
      })
      .option('cpu-hog-minutes', {
        type: 'number',
        default: 30,
        description:
          'How long a process must have been busy before it is flagged as a CPU hog',
      })
      .option('stuck-upload-percent', {
        type: 'number',
        default: 80,
        description:
          'A gh-upload-log/sanitizer process counts as stuck when its lifetime average uses this much of one core',
      })
      .option('stuck-upload-minutes', {
        type: 'number',
        default: 30,
        description:
          'How long a gh-upload-log/sanitizer process must have run before it can be called stuck',
      })
      .option('kill-stuck-uploads', {
        type: 'boolean',
        default: false,
        description:
          'Kill a gh-upload-log/sanitizer process only when it has averaged --stuck-upload-percent of a core for --stuck-upload-minutes and its read/write fd positions did not move over the sample window; without this flag it is reported only',
      })
      .option('check-uploads', {
        type: 'boolean',
        default: false,
        description:
          'Only check gh-upload-log/sanitizer processes for a stuck sanitizer; report only unless --kill-stuck-uploads is given, nothing else runs',
      })
      .option('update-dependency', {
        type: 'array',
        string: true,
        default: [],
        description:
          'Only update these top-level global dependencies in the hive-mind container with `bun update -g --latest` (transitive dependencies included); --dry-run previews, other steps do not run',
      })
      .option('update-all-dependencies', {
        type: 'boolean',
        default: false,
        description:
          'Only update every top-level global dependency in the hive-mind container with `bun update -g --latest`; --dry-run previews, other steps do not run',
      })
      .option('kill-stuck-browsers', {
        type: 'boolean',
        default: true,
        description:
          'Kill a Playwright browser of a task that burns CPU while unused, only when the task log confirms it in a known way (Claude session transcript: no browser call pending, the session moved on to 3 other tool calls and --browser-idle-minutes passed, or --browser-max-idle-minutes passed; a single @playwright/mcp >= 0.0.83 that launches a new browser on its next call), and detached browsers or orphaned Chrome child processes that nothing can use; anything else is reported only',
      })
      .option('browser-idle-minutes', {
        type: 'number',
        default: 5,
        description:
          'A browser counts as unused when its last call ended this long ago and the session made 3 other tool calls since',
      })
      .option('browser-max-idle-minutes', {
        type: 'number',
        default: 30,
        description:
          'A browser counts as unused when its last call ended this long ago, whatever the session did since',
      })
      .option('browser-busy-cores', {
        type: 'number',
        default: 0.5,
        description:
          'A browser counts as stuck when its processes use at least this many cores while unused',
      })
      .option('repair-records', {
        type: 'boolean',
        default: true,
        description:
          'Repair start-command records and attach completion watchers to running task containers',
      })
      .option('report', {
        type: 'boolean',
        default: true,
        description:
          'Report dead tasks (killed, lost, failed recovery) as hive-mind issues, once per attempt',
      })
      .option('report-dry', {
        type: 'boolean',
        default: false,
        description:
          'Write issue previews on the server instead of uploading logs and posting',
      })
      .option('report-failed', {
        type: 'boolean',
        default: true,
        description:
          'Also report tasks that failed with any other non-zero exit (--no-report-failed skips them)',
      })
      .option('report-repo', {
        type: 'string',
        default: 'link-assistant/hive-mind',
        description: 'Repository the reports go to',
      })
      .option('max-reports', {
        type: 'number',
        default: 5,
        description:
          'At most this many issues/comments per run (one per failure signature)',
      })
      .option('public-logs', {
        type: 'boolean',
        default: false,
        description: 'Upload logs as public gists/repos (default private)',
      })
      .option('follow', {
        type: 'boolean',
        default: true,
        description:
          'Keep monitoring running tasks the bot does not track until they end, then report and clean them up',
      })
      .option('dss-clean', {
        type: 'boolean',
        default: true,
        description:
          'Safe disk cleanup with disk-space-saviour on the host and in every running container at the end',
      })
      .option('dss-dry', {
        type: 'boolean',
        default: false,
        description: 'Only show what the disk cleanup would delete',
      })
      .option('journal-keep-days', {
        type: 'number',
        default: 3,
        description:
          'Vacuum the systemd journal to this many days during disk cleanup (0 keeps it)',
      })
      .option('fix-live-restore', {
        type: 'boolean',
        default: true,
        description:
          'Enable Docker live-restore with a daemon reload (never a restart) when it is off',
      })
      .option('collect', {
        type: 'array',
        string: true,
        default: [],
        description:
          'Only collect these executions (UUIDs, 8+ char UUID prefixes or session names), successful ones too: confirm each with `$ --list`/`$ --status`, upload its log privately with `$ --upload-log`, print how it ended, flag suspected false successes and tool-call loops, and whether a failure is already reported on GitHub; nothing else runs',
      })
      .option('collect-matching', {
        type: 'string',
        description:
          'Like --collect, for every execution of the last --since-hours whose command matches this pattern (e.g. formal-ai)',
      })
      .option('diagnose', {
        type: 'boolean',
        default: false,
        description:
          'Only diagnose resource use (read-only): machine, every container and service, each task with its owner, processes with how they were started; nothing else runs',
      })
      .option('diagnose-seconds', {
        type: 'number',
        default: 15,
        description: 'Sample window of --diagnose',
      })
      .option('disk-report', {
        type: 'boolean',
        default: false,
        description:
          'Only report where disk space is used (read-only): filesystem/inodes, Docker images, containers, volumes and build cache, container layers and logs, selected host directories; nothing else runs',
      })
      .option('global-tools-only', {
        type: 'boolean',
        default: false,
        description:
          'Only check/clean server-global Claude/Codex extensions, preserving auth/history and Playwright MCP; --dry-run or --no-fix-global-tools audits only (exit 1 if dirty)',
      })
      .option('fix-global-tools', {
        type: 'boolean',
        default: true,
        description:
          'Remove server-global plugins, user skills, hooks and non-Playwright MCPs into protected quarantine; --no-fix-global-tools reports only',
      })
      .option('tool-services-only', {
        type: 'boolean',
        default: false,
        description:
          'Only stop recognized idle tool background services; no task recovery, tool probes, configuration cleanup or reporting',
      })
      .option('service-tools', {
        type: 'string',
        default: 'codex,claude',
        description: 'Tool service scope: codex, claude, or codex,claude',
      })
      .option('stop-idle-tool-services', {
        type: 'boolean',
        default: true,
        description:
          'Stop idle managed Codex services and orphan Claude browser helpers when no matching task or foreground work exists',
      })
      .option('check-tasks', {
        type: 'boolean',
        default: false,
        description:
          'Only run the task check: kill unused Playwright browsers when confirmed (see --kill-stuck-browsers), report Formal AI clients that wait or loop; nothing else runs',
      })
      .option('dry-run', {
        type: 'boolean',
        default: false,
        description:
          "Change nothing and say what would be done: no browser kills, resumes, cleanup, record repairs, uploads or posts (report previews go to /tmp/auto-fix in the bot container), disk cleanup (scan only), live-restore fix, Docker or container start; one pass, no following. Only auto-fix's own scratch files are written",
      })
      .option('verbose', {
        type: 'boolean',
        default: false,
        description: 'Enable verbose debug output',
      })
      .option('dangerously-show-secrets', {
        type: 'boolean',
        default: false,
        description: 'Show secret values in debug output',
      }),
});

// Unknown options are refused, not ignored: a mistyped `--report-dyr` or a
// `--help` must not start a full run that reports, resumes and cleans up.
{
  const known = new Set([
    'help',
    'h',
    'server-ip',
    'server-user',
    'server-pass',
    'since-hours',
    'wait-minutes',
    'poll-seconds',
    'resume',
    'cleanup',
    'cleanup-failed',
    'cleanup-all-failed',
    'max-resumes',
    'bot-grace-minutes',
    'snapshot-headroom-gb',
    'min-free-gb',
    'max-dockerd-rss-gb',
    'cpu-hog-percent',
    'cpu-hog-minutes',
    'stuck-upload-percent',
    'stuck-upload-minutes',
    'kill-stuck-uploads',
    'check-uploads',
    'update-dependency',
    'update-all-dependencies',
    'kill-stuck-browsers',
    'browser-idle-minutes',
    'browser-max-idle-minutes',
    'browser-busy-cores',
    'repair-records',
    'report',
    'report-dry',
    'report-failed',
    'report-repo',
    'max-reports',
    'public-logs',
    'follow',
    'dss-clean',
    'dss-dry',
    'journal-keep-days',
    'fix-live-restore',
    'collect',
    'collect-matching',
    'diagnose',
    'diagnose-seconds',
    'disk-report',
    'check-tasks',
    'global-tools-only',
    'fix-global-tools',
    'dry-run',
    'verbose',
    'dangerously-show-secrets',
  ]);
  const given = process.argv
    .slice(2)
    .filter((a) => /^-/.test(a) && a !== '--')
    .map((a) => a.replace(/^-+/, '').split('=')[0]);
  for (const name of [
    'tool-services-only',
    'service-tools',
    'stop-idle-tool-services',
  ])
    known.add(name);
  const unknown = given.filter(
    (name) =>
      !known.has(name) && !(name.startsWith('no-') && known.has(name.slice(3)))
  );
  if (
    !String(config.serviceTools)
      .split(',')
      .every((tool) => ['codex', 'claude'].includes(tool.trim()))
  ) {
    console.error('--service-tools must be codex, claude, or codex,claude');
    process.exit(2);
  }
  if (given.includes('cleanup-failed') && !config.cleanupFailed) {
    console.error('--cleanup-failed requires a preservation receipt filename');
    process.exit(2);
  }
  if (config.cleanupFailed && given.includes('no-cleanup') && !config.dryRun) {
    console.error(
      '--cleanup-failed conflicts with --no-cleanup; use --dry-run to preview'
    );
    process.exit(2);
  }
  if (config.cleanupAllFailed && config.cleanupFailed) {
    console.error(
      '--cleanup-all-failed conflicts with --cleanup-failed; use one or the other'
    );
    process.exit(2);
  }
  if (
    config.updateAllDependencies &&
    (Array.isArray(config.updateDependency)
      ? config.updateDependency.length
      : config.updateDependency)
  ) {
    console.error(
      '--update-all-dependencies conflicts with --update-dependency; use one or the other'
    );
    process.exit(2);
  }
  if (given.includes('help') || given.includes('h') || unknown.length) {
    if (unknown.length)
      console.error(
        `Unknown option(s): ${unknown.map((n) => '--' + n).join(', ')}`
      );
    const header = fs
      .readFileSync(new URL(import.meta.url), 'utf8')
      .split('\n')
      .slice(2);
    const end = header.findIndex((l) => !l.startsWith('//'));
    console.log(
      header
        .slice(0, end === -1 ? undefined : end)
        .map((l) => l.replace(/^\/\/ ?/, ''))
        .join('\n')
    );
    process.exit(unknown.length ? 2 : 0);
  }
}

// --dry-run turns off every action, whatever else was given.
if (config.dryRun) {
  Object.assign(config, {
    killStuckBrowsers: false,
    killStuckUploads: false,
    resume: false,
    cleanup: false,
    repairRecords: false,
    reportDry: true,
    dssDry: true,
    fixLiveRestore: false,
    fixGlobalTools: false,
    stopIdleToolServices: false,
    follow: false,
  });
  console.log(
    ">>> Dry run: nothing is changed (no kills, resumes, cleanup, repairs, uploads, posts or starts); what would be done is reported, and only auto-fix's own scratch files are written"
  );
}

const VERBOSE = config.verbose;
const SHOW_SECRETS = config.dangerouslyShowSecrets;

const mask = (value) => (SHOW_SECRETS ? value : '***');
const log = (...args) => {
  if (VERBOSE) console.log('[DEBUG]', ...args);
};

const IP = config.serverIp;
const USER = config.serverUser;
const PASS = config.serverPass;
const CONTAINER = 'hive-mind';

const missing = [];
if (!IP) missing.push('SERVER_IP');
if (!USER) missing.push('SERVER_USER');
if (!PASS) missing.push('SERVER_PASS');
if (missing.length) {
  console.error(
    `>>> ERROR: Missing required .lenv values: ${missing.join(', ')}`
  );
  process.exit(1);
}

// Password login only: PubkeyAuthentication=no keeps ssh from trying (and
// warning about) local key files.
const SSH_OPTS =
  '-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=10 -o LogLevel=ERROR -o PubkeyAuthentication=no';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const b64 = (text) => Buffer.from(text).toString('base64');

// sshpass exit codes: 5 - invalid password, 6 - unknown host key.
// The server is under constant SSH brute force, so sshd sometimes drops a
// connection (code 255); those are retried instead of failing the run.
const ssh = async (
  command,
  { silent = false, mirror = !silent, ignoreErrors = false, retries = 3 } = {}
) => {
  if (!silent) {
    console.log(
      `>>> sshpass -p '${mask(PASS)}' ssh ${SSH_OPTS} ${USER}@${IP} ${command}`
    );
  }
  for (let attempt = 1; ; attempt++) {
    try {
      const result = await $({
        mirror,
      })`sshpass -p ${PASS} ssh ${SSH_OPTS.split(' ')} ${USER}@${IP} ${command}`;
      log(`Exit code: ${result.code}`);
      return result;
    } catch (error) {
      const code = error.code ?? error.exitCode;
      log(`Command failed (code ${code}):`, error.message || error);
      if (code === 5) {
        console.error(
          '>>> ERROR: Invalid password. Check SERVER_PASS in .lenv'
        );
        process.exit(1);
      }
      if (code === 6) {
        console.error('>>> ERROR: Unknown host key. Check SERVER_IP in .lenv');
        process.exit(1);
      }
      if (code === 255 && attempt < retries) {
        await sleep(5000);
        continue;
      }
      if (!ignoreErrors) throw error;
      return error;
    }
  }
};

// Run a bash script on the host. Base64 keeps quoting out of the way, so the
// command itself is not echoed; `show` prints the script's output.
const hostScript = (script, { show = false, ...opts } = {}) =>
  ssh(`echo ${b64(script)} | base64 -d | bash`, {
    silent: true,
    mirror: show,
    ...opts,
  });

// Run an ES module inside the hive-mind container as the bot's user, so it sees
// the same files, `$` executions and hive-mind install as the bot. The module
// prints one `AF_JSON:` line, which is returned parsed.
const containerModule = async (source, params = {}) => {
  const code = `const PARAMS = ${JSON.stringify(params)};\n${source}`;
  const result = await ssh(
    `docker exec ${CONTAINER} bash -lc 'node --input-type=module -e "$(echo ${b64(code)} | base64 -d)"'`,
    { silent: true }
  );
  const line = (result.stdout || '')
    .split('\n')
    .find((l) => l.startsWith('AF_JSON:'));
  if (!line)
    throw new Error(
      `No result from container module: ${(result.stdout || '').slice(-500)} ${(result.stderr || '').slice(-500)}`
    );
  return JSON.parse(line.slice('AF_JSON:'.length));
};

// Run an ES module on the host with the host's Node.js, as the SSH user (root):
// for what only the host sees (journal, snapshots, other containers' layers).
const hostModule = async (source, params = {}) => {
  const code = `const PARAMS = ${JSON.stringify(params)};\n${source}`;
  // Each invocation owns its scratch: concurrent diagnostic clients must never
  // replace another run's source/parameters before Node opens the module.
  const command = `mkdir -p /root/auto-fix && af_run_dir=$(mktemp -d /root/auto-fix/run.XXXXXXXX) && trap 'rm -f -- "$af_run_dir/module.mjs"; rmdir -- "$af_run_dir"' EXIT && echo ${b64(code)} | base64 -d > "$af_run_dir/module.mjs" && node "$af_run_dir/module.mjs"`;
  const result = await ssh(command, { silent: true, mirror: VERBOSE });
  const line = (result.stdout || '')
    .split('\n')
    .find((l) => l.startsWith('AF_JSON:'));
  if (!line)
    throw new Error(
      `No result from host module: ${(result.stdout || '').slice(-500)} ${(result.stderr || '').slice(-500)}`
    );
  return JSON.parse(line.slice('AF_JSON:'.length));
};

// `not_found` only when Docker says so: an empty answer from a dropped SSH
// connection must not be read as "the container and its state are gone".
const getContainerStatus = async () => {
  for (let attempt = 1; attempt <= 5; attempt++) {
    const result = await ssh(
      `docker inspect -f {{.State.Status}} ${CONTAINER} 2>&1`,
      { silent: true, ignoreErrors: true }
    );
    const out = (result.stdout || '').trim();
    const state =
      /^(running|exited|created|paused|restarting|removing|dead)$/m.exec(out);
    if (state) return state[1];
    if (/no such (object|container)/i.test(out)) return 'not_found';
    log(`Container status attempt ${attempt} unreadable: ${out || '(empty)'}`);
    await sleep(5000);
  }
  return 'unknown';
};

// The modules that run on the server live next to this script in auto-fix/,
// so they are plain JavaScript files instead of escaped strings in here.
const MODULE_DIR = new URL('./auto-fix/', import.meta.url);
const readModule = (name) => fs.readFileSync(new URL(name, MODULE_DIR), 'utf8');
const RECOVERY_MODULE = readModule('recovery.mjs');
const REPAIR_MODULE = readModule('repair-records.mjs');
const REPORT_MODULE = readModule('report.mjs');
const HOST_FACTS_MODULE = readModule('host-facts.mjs');
const DISK_CLEAN_MODULE = readModule('disk-clean.mjs');
const CPU_MODULE = readModule('cpu.mjs');
const DIAGNOSE_MODULE = readModule('diagnose.mjs');
const DISK_USAGE_MODULE = readModule('disk-usage.mjs');
const TASKS_MODULE = readModule('tasks.mjs');
const STUCK_UPLOADS_MODULE = readModule('stuck-uploads.mjs');
const DEPENDENCIES_MODULE = readModule('dependencies.mjs');
const GLOBAL_TOOLS_MODULE = readModule('global-tools.mjs');
const GLOBAL_TOOLS_SOURCE = readModule('global-tools.py');
const TOOL_SERVICES_MODULE = readModule('tool-services.mjs');
const TOOL_SERVICES_SOURCE = readModule('tool-services.py');
const ISSUE_FOOTER = readModule('issue-footer.md').trim();
const HIVE_CLEANUP_MODULE = readModule('hive-cleanup.mjs');
const HIVE_CLEANUP_GUARD_SOURCE = readModule('hive-cleanup-guard.py');
const SELECT_FAILED_MODULE = readModule('select-failed.mjs');
const VERIFY_CLEANUP_BACKUP_MODULE = readModule('verify-cleanup-backup.mjs');

const checkGlobalTools = async ({
  act = config.fixGlobalTools,
  brief = false,
} = {}) => {
  const result = await hostModule(GLOBAL_TOOLS_MODULE, {
    source: GLOBAL_TOOLS_SOURCE,
    act,
  });
  if (
    !brief ||
    !result.clean ||
    result.contexts.some((c) => c.findings.length)
  ) {
    for (const line of result.report) console.log(`>>> ${line}`);
  }
  fs.mkdirSync('data', { recursive: true });
  fs.writeFileSync(
    'data/global-tools-last.json',
    JSON.stringify(result, null, 2) + '\n'
  );
  if (act && !result.clean)
    throw new Error(
      'Server-global tool contamination remains; recovery is stopped. See data/global-tools-last.json'
    );
  return result;
};

const checkToolServices = async ({
  act = config.stopIdleToolServices,
  brief = false,
} = {}) => {
  const tools = [
    ...new Set(
      String(config.serviceTools)
        .split(',')
        .map((tool) => tool.trim())
    ),
  ];
  const result = await hostModule(TOOL_SERVICES_MODULE, {
    source: TOOL_SERVICES_SOURCE,
    act,
    tools,
  });
  if (
    !brief ||
    result.signals.length ||
    result.plans.some((p) => p.pids.length)
  ) {
    for (const line of result.report) console.log(`>>> ${line}`);
  }
  fs.mkdirSync('data', { recursive: true });
  fs.writeFileSync(
    'data/tool-services-last.json',
    JSON.stringify(result, null, 2) + '\n',
    { mode: 0o600 }
  );
  return result;
};

// What uses the CPU now (auto-fix/cpu.mjs, read-only). A hog is reported with
// the task it works for; nothing is stopped: an AI session that loops is
// reported, never killed. `brief` prints one line plus the warnings.
const checkCpu = async ({ brief = false } = {}) => {
  let cpu;
  try {
    cpu = await hostModule(CPU_MODULE, {
      sampleSeconds: 5,
      top: 5,
      hogPercent: config.cpuHogPercent,
      hogAveragePercent: 80,
      hogMinutes: config.cpuHogMinutes,
    });
  } catch (error) {
    console.log(`>>> Could not sample CPU use: ${error.message}`);
    return null;
  }
  const who = (p) =>
    `${p.comm}${p.container ? ' in ' + p.container : ' (host)'}`;
  const top = cpu.top
    .slice(0, brief ? 3 : 5)
    .map((p) => `${who(p)} ${p.percent}%`)
    .join(', ');
  console.log(
    `>>> CPU: ${cpu.busyPercent}% busy (${cpu.busyCores}/${cpu.cpus} cores) over ${cpu.sampleSeconds}s, I/O wait ${cpu.iowaitPercent}%, tasks waiting for a CPU ${cpu.waitingPercent ?? '?'}% of the time, load ${cpu.load1}/${cpu.load5}/${cpu.load15}; top: ${top || 'idle'}`
  );
  if (!brief) {
    for (const p of cpu.top)
      console.log(
        `>>>   ${String(p.percent).padStart(4)}%  pid ${p.pid}  ${who(p)}  (${p.cpuMinutes} CPU min in ${p.elapsedMinutes} min)  ${p.command}`
      );
    // Waited: share of the sample in which one of its threads was ready to run but had no CPU.
    console.log(
      `>>>   by container or service (cores, exited processes included; waited = ready to run but no CPU free): ${cpu.containers.map((c) => `${c.name}${c.task ? ` (${c.task})` : ''} ${c.cores}${c.waitedPercent ? ` (waited ${c.waitedPercent}%)` : ''}`).join(', ')}`
    );
  }
  // Not the load average: it counts I/O-waiting and bursty threads too (hive-mind#3582).
  if (cpu.busyPercent >= 90 || cpu.waitingPercent >= 50)
    console.log(
      `>>> WARNING: the CPUs are saturated (${cpu.busyPercent}% busy, tasks wait for a CPU ${cpu.waitingPercent ?? '?'}% of the time): tasks are slowed down`
    );
  for (const h of cpu.hogs) {
    const hours = `${Math.floor(h.elapsedMinutes / 60)}h${String(h.elapsedMinutes % 60).padStart(2, '0')}m`;
    console.log(
      `>>> WARNING: CPU hog: ${who(h)} (pid ${h.pid}) uses ${h.percent}% of a core now and ${h.averagePercent}% on average for ${hours}: possibly a busy loop (reported only, not stopped)`
    );
    if (h.task) console.log(`>>>   it runs ${h.task}`);
    if (h.threads)
      console.log(
        `>>>   in ${h.followSeconds}s more: ${h.threads.map((t) => `thread ${t.comm} ${t.cores} cores`).join(', ') || 'no thread busy'}; ${h.syscallsPerSecond === 0 ? '0 system calls (reads and writes nothing): a loop in its own code' : `${h.syscallsPerSecond} system calls/s`}`
      );
    for (const k of h.backlog || []) {
      const w = k.writer;
      const kb = (n) => (n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`);
      const fds = w
        ? w.fds
            .map(
              (fd) =>
                ({ 0: 'stdin', 1: 'stdout', 2: 'stderr' })[fd] || `fd ${fd}`
            )
            .join('/')
        : '';
      console.log(
        w
          ? `>>>   not reading: ${kb(k.unread)} unread on its fd ${k.fd} from ${w.comm} (pid ${w.pid}, its ${fds}), which has ${kb(k.writerQueued || 0)} more queued${k.writerQueued ? ` and waits (${w.wchan || '?'}): that program is stalled until this one reads` : ''}`
          : `>>>   not reading: ${kb(k.unread)} unread on its fd ${k.fd}`
      );
    }
    for (const peer of h.peers)
      console.log(
        `>>>   it is serving ${peer.name}${peer.task ? ': ' + peer.task : ''}`
      );
    if (/formal-ai/.test(h.container || ''))
      console.log(
        '>>>   Formal AI busy for hours with no progress is reported to link-assistant/formal-ai (with `--collect` of the task it serves)'
      );
  }
  // Stalled even without a hog: a program blocked writing output nobody reads.
  for (const x of cpu.stalls || []) {
    const kb = (n) => `${Math.round(n / 1024)} KB`;
    const r = x.reader;
    console.log(
      `>>> WARNING: stuck: in ${x.container}${x.task ? ` (${x.task})` : ''}, ${x.writer.comm} (pid ${x.writer.pid}) cannot continue: it has ${kb(x.unread + x.writerQueued)} of output that ${r.comm} (pid ${r.pid}, fd ${r.fd}) has not read for 2s+ (${x.writer.comm} waits in ${x.writer.wchan || '?'}). ${r.comm} has used ${r.averagePercent}% of a core on average for ${Math.floor(r.elapsedMinutes / 60)}h${String(r.elapsedMinutes % 60).padStart(2, '0')}m. Reported only.`
    );
  }
  return cpu;
};
// A gh-upload-log/sanitizer process that has burned a core for a long time
// while its file positions do not move. The evidence is kept in
// data/stuck-uploads-last.json; it is killed only with --kill-stuck-uploads.
const checkStuckUploads = async ({
  kill = config.killStuckUploads,
  brief = false,
} = {}) => {
  let result;
  try {
    result = await hostModule(STUCK_UPLOADS_MODULE, {
      sampleSeconds: 5,
      minMinutes: config.stuckUploadMinutes,
      cpuPercent: config.stuckUploadPercent,
      act: kill,
    });
  } catch (error) {
    console.log(`>>> Could not check for stuck uploads: ${error.message}`);
    return null;
  }
  const where = (u) =>
    `${u.comm}${u.container ? ' in ' + u.container : ' (host)'}`;
  const bytes = (n) =>
    n >= 1048576
      ? `${Math.round(n / 1048576)} MB`
      : n >= 1024
        ? `${Math.round(n / 1024)} KB`
        : `${n} B`;
  const file = (u, p) => u.files.find((f) => f.path === p);
  for (const u of result.uploads) {
    if (!u.confirmed) {
      if (u.suspicious)
        console.log(
          `>>> WARNING: upload looks stuck but is below --stuck-upload-minutes ${result.minMinutes}m: ${where(u)} (pid ${u.pid}) has used ${u.averagePercent}% of a core for ${u.elapsed} with ${bytes(u.progressBytes)} of file progress in ${result.sampleSeconds}s; not killed`
        );
      else if (!brief)
        console.log(
          `>>> Upload check: ${where(u)} (pid ${u.pid}), ${u.cpuPercent}% CPU now, ${bytes(u.progressBytes)} of file progress in ${result.sampleSeconds}s over ${u.elapsed}; not stuck`
        );
      continue;
    }
    const input = u.input && file(u, u.input);
    const output = u.files
      .filter((f) => f.path !== u.input)
      .sort((x, y) => y.size - x.size)[0];
    console.log(
      `>>> WARNING: stuck upload: ${where(u)} (pid ${u.pid}) has used ${u.averagePercent}% of a core for ${u.elapsed} and made no file progress in ${result.sampleSeconds}s${input ? `: read ${input.pos}, write ${output ? output.pos : '?'}` : ''}. It is not uploading; the sanitizer is likely stuck (gh-upload-log#65).`
    );
    if (u.versions.ghUploadLog || u.versions.sensitiveDataSanitizer)
      console.log(
        `>>>   versions: gh-upload-log ${u.versions.ghUploadLog || '?'}, sensitive-data-sanitizer ${u.versions.sensitiveDataSanitizer || '?'}`
      );
    if (u.input)
      console.log(
        `>>>   input: ${u.input}${input ? ` (${bytes(input.size)})` : ''}`
      );
    if (output)
      console.log(`>>>   output: ${output.path} (${bytes(output.size)})`);
    if (u.trigger)
      console.log(
        `>>>   first netrc-like line at byte ${u.trigger.byte}: ${u.trigger.line}`
      );
    const killed = result.killed.find((k) => k.pid === u.pid);
    if (result.act)
      console.log(`>>>   ${killed ? killed.action : 'kill requested'}`);
    else
      console.log(
        '>>>   not killed; re-run with --kill-stuck-uploads to stop it, or update gh-upload-log after the sanitizer fix is released'
      );
  }
  if (!brief && !result.uploads.length)
    console.log('>>> No gh-upload-log/sanitizer processes');
  if (result.hung.length && !result.act)
    console.log(
      `>>> ${result.hung.length} stuck upload process(es) reported; see data/stuck-uploads-last.json`
    );
  if (result.suspicious.length && !brief)
    console.log(
      `>>> ${result.suspicious.length} upload process(es) look stuck but are below --stuck-upload-minutes ${result.minMinutes}m`
    );
  fs.mkdirSync('data', { recursive: true });
  fs.writeFileSync(
    'data/stuck-uploads-last.json',
    JSON.stringify(result, null, 2) + '\n',
    { mode: 0o600 }
  );
  return result;
};
// Stuck work inside running tasks (auto-fix/tasks.mjs): Playwright browsers
// that burn CPU while unused, killed only when the task log confirms it, and
// Formal AI clients that wait or retry instead of failing (reported only:
// neither a restart nor a stop of the sidecar ends them). `brief` prints only
// what needs attention.
const checkTasks = async ({
  kill = config.killStuckBrowsers,
  brief = false,
} = {}) => {
  let result;
  try {
    result = await hostModule(TASKS_MODULE, {
      seconds: 5,
      busyCores: config.browserBusyCores,
      idleMinutes: config.browserIdleMinutes,
      maxIdleMinutes: config.browserMaxIdleMinutes,
      kill,
    });
  } catch (error) {
    console.log(`>>> Could not check the tasks: ${error.message}`);
    return null;
  }
  const attention =
    /^(KILLED|STUCK)|^Orphaned|cannot progress|repeats the same steps/;
  for (const line of result.report)
    if (!brief || attention.test(line))
      console.log(`>>> ${attention.test(line) ? 'WARNING: ' : ''}${line}`);
  return result;
};

// disk-space-saviour, pinned: the tarball's npm integrity is checked on the
// server before it runs as root.
const DSS = {
  version: '0.17.0',
  tarballUrl:
    'https://registry.npmjs.org/disk-space-saviour/-/disk-space-saviour-0.17.0.tgz',
  integrity:
    'sha512-tpwpyMkf7W9Ug8egqUY/HWnX+JUd2hNYn9NeJDxKdne5BW/VtOdV5bKC2/ibtU+mFO/Mziid2AcQ75XDzVXvBA==',
};

// Dead tasks -> hive-mind issues. The facts only the host has (journal, the
// container's final state, its layer and Git work) are collected first and
// copied into the bot container, where the report module runs with
// hive-mind's own log uploader and sanitizer and the bot's gh login.
const reportDeadTasks = async () => {
  const sinceMs = Date.now() - config.sinceHours * 3600000;
  const { events } = await containerModule(REPORT_MODULE, {
    mode: 'candidates',
    sinceMs,
    reportFailed: config.reportFailed,
    repo: config.reportRepo,
  });
  if (!events.length) {
    console.log('>>> No unreported dead tasks');
    return;
  }
  for (const ev of events)
    console.log(
      `>>>   ${ev.reason}: ${ev.url || ev.sessionName} attempt ${ev.attempt} (exit ${ev.exitCode ?? '?'}${ev.exitReason ? ', ' + ev.exitReason : ''})`
    );
  await hostModule(HOST_FACTS_MODULE, {
    events,
    out: '/root/auto-fix/facts.json',
  });
  await ssh(
    `docker cp /root/auto-fix/facts.json ${CONTAINER}:/tmp/auto-fix-facts.json && docker exec -u 0 ${CONTAINER} chmod 644 /tmp/auto-fix-facts.json`,
    { silent: true }
  );
  const { results, errors } = await containerModule(REPORT_MODULE, {
    mode: 'report',
    events,
    factsPath: '/tmp/auto-fix-facts.json',
    dry: config.reportDry,
    repo: config.reportRepo,
    publicLogs: config.publicLogs,
    maxReports: config.maxReports,
    footer: ISSUE_FOOTER,
  });
  for (const r of results)
    console.log(
      `>>>   ${r.signature}: ${r.action}${r.url ? ' ' + r.url : ''}${r.preview ? ' (preview in the container: ' + r.preview + ')' : ''}  [${r.keys.length} attempt(s)]`
    );
  for (const e of errors) console.log(`>>>   report error: ${e}`);
};

// Failed executions whose dead attempts are all reported: their stopped
// containers (and the snapshot images they were resumed from) are removed when
// no Git work dir in them holds uncommitted or unpushed work. The record and
// the start-command log stay as the evidence the report links to.
const NAME = /^[\w.-]+$/;
const cleanReportedFailed = async () => {
  const { dead } = await containerModule(REPORT_MODULE, {
    mode: 'reported-dead',
    repo: config.reportRepo,
    reportFailed: config.reportFailed,
    maxResumes: config.maxResumes,
  });
  if (!dead.length) return;
  const events = dead.flatMap((d) =>
    d.containers.map((name) => ({
      key: name,
      containerNames: [name],
      sessionName: name,
      finishedAt: d.finishedAt,
    }))
  );
  await hostModule(HOST_FACTS_MODULE, {
    events,
    out: '/root/auto-fix/clean-facts.json',
  });
  const { facts = {} } = JSON.parse(
    (await ssh('cat /root/auto-fix/clean-facts.json', { silent: true }))
      .stdout || '{}'
  );
  for (const d of dead) {
    const label = d.url || d.uuid;
    const unsafe = d.containers
      .map((name) => {
        const work = facts[name]?.work;
        if (!NAME.test(name)) return `${name}: unexpected container name`;
        if (!work || !Array.isArray(work.repos))
          return `${name}: Git work could not be checked (${work?.error || 'no facts'})`;
        const left = work.repos.filter(
          (r) =>
            r.dirtyFiles !== 0 ||
            r.unpushedCommits !== 0 ||
            r.submoduleDirtyFiles ||
            r.submoduleUnpushedCommits
        );
        return left.length
          ? `${name}: ` +
              left
                .map(
                  (r) =>
                    `${r.dir} has ${r.dirtyFiles} uncommitted file(s) and ${r.unpushedCommits ?? 'unknown'} unpushed commit(s)` +
                    (r.submoduleDirtyFiles || r.submoduleUnpushedCommits
                      ? `, plus ${r.submoduleDirtyFiles} file(s) and ${r.submoduleUnpushedCommits} commit(s) in submodules`
                      : '')
                )
                .join('; ')
          : null;
      })
      .filter(Boolean);
    if (unsafe.length) {
      console.log(`>>>   kept failed task ${label}: ${unsafe.join('; ')}`);
      continue;
    }
    const images = d.sessionNames
      .filter((n) => NAME.test(n))
      .map((n) => 'start-command-resume/' + n);
    // No -f: Docker refuses to remove a running container or an image in use.
    const script = [
      ...d.containers.map(
        (name) =>
          `docker rm ${name} >/dev/null 2>&1 && echo "container ${name}" || echo "could not remove container ${name}"`
      ),
      ...images.map(
        (repo) =>
          `for i in $(docker images --format '{{.Repository}}:{{.Tag}}' ${repo}); do docker rmi "$i" >/dev/null 2>&1 && echo "image $i" || echo "kept image $i (in use)"; done`
      ),
    ].join('\n');
    const out = (
      (await hostScript(script, { ignoreErrors: true })).stdout || ''
    ).trim();
    for (const line of out.split('\n').filter(Boolean))
      console.log(
        `>>>   cleaned up ${line} (${label} failed, reported, no unsaved Git work)`
      );
  }
};

// Start-command records that lost track of a running container are repaired
// and every running task container gets a completion watcher, so tasks end
// up finalized and cleaned up even when the bot no longer watches them.
// Returns the running executions the bot does not track.
const repairRecords = async () => {
  const { actions, adopted } = await containerModule(REPAIR_MODULE, {
    act: config.repairRecords,
  });
  for (const action of actions) console.log(`>>>   ${action}`);
  return adopted.filter((a) => !a.botTracked).map((a) => a.uuid);
};

// Main execution
let step = 0;
const nextStep = (msg) => console.log(`>>> Step ${++step}: ${msg}`);

nextStep('Checking SSH availability');
for (;;) {
  const result = await ssh('echo up', {
    silent: true,
    ignoreErrors: true,
    retries: 1,
  });
  if ((result.stdout || '').trim() === 'up') break;
  console.log('>>> SSH not available, retrying in 10s');
  await sleep(10000);
}
console.log('>>> Server is reachable');

// Live cleanup of every stopped failed task container. Tasks that still have a
// running container are kept, and the real hive-cleanup CLI only sees the
// selected stopped failures plus the running containers. No preservation backup
// is made, and this mode never runs reporting, recovery, or DSS.
if (config.cleanupAllFailed) {
  nextStep('Selecting stopped failed task containers (active tasks are kept)');
  const selection = await containerModule(SELECT_FAILED_MODULE);
  for (const k of selection.kept)
    console.log(
      `>>>   kept ${k.name}: ${k.reason}${k.task ? ' (' + k.task + ')' : ''}`
    );
  console.log(
    `>>> Found ${selection.targets.length} failed task container(s) to remove, ${selection.kept.length} kept, ${selection.activeTasks.length} active task target(s)`
  );
  if (!selection.targets.length) {
    console.log('>>> No failed task containers to clean up');
    process.exit(0);
  }
  nextStep(
    `Running hive-cleanup for those containers only${config.dryRun ? ' (dry run)' : ''}`
  );
  const manifest = {
    schema: 'auto-fix-all-failed-cleanup-v1',
    createdAt: new Date().toISOString(),
    preservationVerified: false,
    selection: {
      mode: 'live-all-failed',
      activeTasks: selection.activeTasks,
      selectedAt: new Date().toISOString(),
    },
    targets: selection.targets,
  };
  const result = await containerModule(HIVE_CLEANUP_MODULE, {
    manifest,
    guardSource: HIVE_CLEANUP_GUARD_SOURCE,
    liveSelection: true,
    dry: config.dryRun,
    reportRepo: config.reportRepo,
  });
  for (const line of (result.output || '').split('\n').filter(Boolean))
    console.log(`>>> ${line}`);
  if (result.error) console.log(`>>> hive-cleanup: ${result.error}`);
  for (const c of result.protected || [])
    console.log(
      `>>> Protected ${c.name}: ${c.status}, PID ${c.beforePid} -> ${c.afterPid}, same start time ${c.sameStartedAt}`
    );
  fs.mkdirSync('data', { recursive: true });
  const resultPath = `data/cleanup-all-failed-${config.dryRun ? 'preview' : 'result'}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  fs.writeFileSync(
    resultPath,
    JSON.stringify({ ...selection, result }, null, 2) + '\n',
    { mode: 0o600 }
  );
  console.log(`>>> Result saved to ${resultPath}`);
  process.exit(result.success ? 0 : 1);
}

// Global dependency updates in the bot container. `bun update -g --latest`
// updates the selected top-level dependencies and their transitive
// dependencies; --dry-run uses Bun's own preview mode. This mode runs nothing
// else (no recovery, reporting, cleanup, or disk work).
if (
  config.updateAllDependencies ||
  (Array.isArray(config.updateDependency)
    ? config.updateDependency.length
    : config.updateDependency)
) {
  const requested = Array.isArray(config.updateDependency)
    ? config.updateDependency
    : [config.updateDependency];
  const names = [
    ...new Set(
      requested
        .filter(Boolean)
        .flatMap((id) => String(id).split(/[\s,]+/))
        .filter(Boolean)
    ),
  ];
  nextStep(
    `Updating ${config.updateAllDependencies ? 'all global dependencies' : names.join(', ')} in ${CONTAINER}${config.dryRun ? ' (dry run)' : ''}`
  );
  let result;
  try {
    result = await containerModule(DEPENDENCIES_MODULE, {
      names,
      all: config.updateAllDependencies,
      dry: config.dryRun,
    });
  } catch (error) {
    console.error(`>>> ERROR: ${error.message}`);
    process.exit(1);
  }
  console.log(`>>> ${result.command}`);
  for (const line of (result.output || '').split('\n').filter(Boolean))
    console.log(`>>> ${line}`);
  for (const c of result.changed)
    console.log(
      `>>>   ${c.name}: ${c.before.installed || c.before.declared} -> ${c.after.installed || c.after.declared}`
    );
  if (result.backup)
    console.log(
      `>>> Global package.json and lockfile backed up to ${result.backup}`
    );
  if (result.error) console.log(`>>> ERROR: ${result.error}`);
  if (result.dry) console.log('>>> Dry run: no dependency was changed');
  else if (!result.changed.length)
    console.log('>>> Dependencies are already at the selected versions');
  fs.mkdirSync('data', { recursive: true });
  const file = `data/dependencies-${config.dryRun ? 'preview' : 'result'}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  fs.writeFileSync(file, JSON.stringify(result, null, 2) + '\n', {
    mode: 0o600,
  });
  console.log(`>>> Result saved to ${file}`);
  process.exit(result.exit === 0 ? 0 : 1);
}

// Explicit cleanup of already-reported failures. Its complete-layer backup is
// checked on the host before the real hive-cleanup CLI gets a guarded Docker
// adapter. This mode never runs general cleanup, reporting, recovery, or DSS.
if (config.cleanupFailed) {
  const manifest = JSON.parse(fs.readFileSync(config.cleanupFailed, 'utf8'));
  nextStep('Verifying the failed-container preservation receipt and archive');
  const backup = await hostModule(VERIFY_CLEANUP_BACKUP_MODULE, { manifest });
  console.log(
    `>>> Verified ${backup.targets} stopped failures, backed up in ${backup.archive} (${(backup.bytes / 2 ** 30).toFixed(2)} GiB)`
  );
  nextStep(
    `Running hive-cleanup for those containers only${config.dryRun ? ' (dry run)' : ''}`
  );
  const result = await containerModule(HIVE_CLEANUP_MODULE, {
    manifest,
    guardSource: HIVE_CLEANUP_GUARD_SOURCE,
    backupVerified: backup.verified,
    dry: config.dryRun,
    reportRepo: config.reportRepo,
  });
  for (const line of result.output.split('\n').filter(Boolean))
    console.log(`>>> ${line}`);
  if (result.error) console.log(`>>> hive-cleanup: ${result.error}`);
  for (const c of result.protected)
    console.log(
      `>>> Protected ${c.name}: ${c.status}, PID ${c.beforePid} -> ${c.afterPid}, same start time ${c.sameStartedAt}`
    );
  fs.mkdirSync('data', { recursive: true });
  const resultPath = `data/hive-cleanup-${config.dryRun ? 'preview' : 'result'}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  // Persist the result and post-cleanup report ledger alongside the host backup.
  const durable = await hostModule(
    `import fs from 'node:fs';\nimport { execFileSync } from 'node:child_process';\nconst c=JSON.parse(execFileSync('docker',['inspect','hive-mind'],{encoding:'utf8'}))[0];\nconst p='/proc/'+c.State.Pid+'/root/home/box/.hive-mind/state/auto-fix-reports.json';\nif(fs.existsSync(p))fs.writeFileSync(PARAMS.directory+'/report-ledger-after.json',fs.readFileSync(p),{mode:0o600});\nconst disk=fs.statfsSync('/');\nconst hostDiskFreeBytes=disk.bavail*disk.bsize;\nfs.writeFileSync(PARAMS.directory+'/'+(PARAMS.result.dry?'cleanup-preview.json':'cleanup-result.json'),JSON.stringify({...PARAMS.result,hostDiskFreeBytes},null,2)+'\\n',{mode:0o600});\nconsole.log('AF_JSON:'+JSON.stringify({saved:true,hostDiskFreeBytes}));`,
    { directory: manifest.backupDirectory, result: { backup, ...result } }
  );
  fs.writeFileSync(
    resultPath,
    JSON.stringify(
      { backup, ...result, hostDiskFreeBytes: durable.hostDiskFreeBytes },
      null,
      2
    ) + '\n',
    { mode: 0o600 }
  );
  console.log(
    `>>> Host disk free: ${(durable.hostDiskFreeBytes / 2 ** 30).toFixed(2)} GiB`
  );
  console.log(`>>> Result saved to ${resultPath}`);
  process.exit(result.success ? 0 : 1);
}

// What changed since the previous --diagnose (its data/diagnose-*.json):
// tasks that ended or started, and the CPU each long-running process used in
// between, so a process that is busy only now and then is not missed.
const sinceLastDiagnosis = (now) => {
  let file;
  let before;
  try {
    file = fs
      .readdirSync('data')
      .filter((f) => /^diagnose-.*\.json$/.test(f))
      .sort()
      .pop();
    if (file) before = JSON.parse(fs.readFileSync(`data/${file}`, 'utf8'));
  } catch {}
  const at = (r) => Date.parse(r?.host?.windowEnd);
  const minutes = (at(now) - at(before)) / 60000;
  if (!before || !(minutes > 0)) return [];
  const lines = [
    `SINCE THE LAST DIAGNOSIS (${Math.round(minutes)} min ago, ${file}):`,
  ];
  const tasks = (r) =>
    new Map(
      (r.groups || []).filter((g) => g.role === 'task').map((g) => [g.name, g])
    );
  const [t0, t1] = [tasks(before), tasks(now)];
  const label = (g) =>
    `task ${g.name.slice(0, 8)} (${(g.task?.url || '?').replace(/^https:\/\/github\.com\//, '')})`;
  const ended = [...t0.values()].filter((g) => !t1.has(g.name));
  const started = [...t1.values()].filter((g) => !t0.has(g.name));
  if (ended.length)
    lines.push(`- Ended (container gone): ${ended.map(label).join(', ')}.`);
  if (started.length)
    lines.push(`- Started: ${started.map(label).join(', ')}.`);
  // Same process = same pid and start time; CPU seconds from either list.
  const procs = (r) => {
    const m = new Map();
    for (const p of [
      ...(r.groups || []).flatMap((g) =>
        (g.top || []).map((t) => ({ ...t, group: g }))
      ),
      ...(r.heavy || []),
    ]) {
      const cpu =
        p.cpuSeconds ?? (p.cpuMinutes != null ? p.cpuMinutes * 60 : null);
      if (cpu != null)
        m.set(`${p.pid}@${p.started}`, {
          ...m.get(`${p.pid}@${p.started}`),
          ...p,
          cpu,
        });
    }
    return m;
  };
  const [p0, p1] = [procs(before), procs(now)];
  const where = (p) => {
    const g = (now.groups || []).find(
      (x) => x.key === (p.group?.key ?? p.group)
    );
    return g?.role === 'task' ? label(g) : g?.name || '';
  };
  const used = [...p1]
    .filter(([k]) => p0.has(k))
    .map(([k, p]) => ({ ...p, cores: (p.cpu - p0.get(k).cpu) / 60 / minutes }))
    .filter((p) => p.cores >= 0.2)
    .sort((x, y) => y.cores - x.cores)
    .slice(0, 5);
  for (const p of used)
    lines.push(
      `- ${p.comm} (pid ${p.pid}) in ${where(p)}: used ${Math.round(p.cores * minutes)} CPU min in these ${Math.round(minutes)} min = ${Math.round(p.cores * 100)}% of a core on average${p.cores >= 0.6 ? ' (busy most of the time, even if quiet right now)' : ''}.`
    );
  if (lines.length === 1)
    lines.push(
      '- No task started or ended, and no long-running process used much CPU in between.'
    );
  return lines;
};

if (config.toolServicesOnly) {
  nextStep(
    `Checking idle tool services (${config.serviceTools})${config.stopIdleToolServices ? '' : ' (report only)'}`
  );
  const result = await checkToolServices();
  process.exit(result.clean ? 0 : 2);
}

// This standalone guard never runs queue recovery, reporting or task cleanup.
if (config.globalToolsOnly) {
  nextStep('Checking server-global Claude/Codex extensions');
  const result = await checkGlobalTools();
  process.exit(result.clean ? 0 : 1);
}

// --check-uploads: only the stuck gh-upload-log/sanitizer check.
if (config.checkUploads) {
  nextStep(
    `Checking for stuck gh-upload-log/sanitizer processes${config.killStuckUploads ? ' (kill confirmed)' : ' (report only)'}`
  );
  const result = await checkStuckUploads();
  if (!result) process.exit(1);
  if (!result.act && (result.hung.length || result.suspicious.length))
    process.exit(2);
  if (result.act && result.killed.some((k) => k.action.startsWith('could not')))
    process.exit(1);
  process.exit(0);
}

// --disk-report: where disk space is used; nothing else runs.
if (config.diskReport) {
  nextStep('Reporting disk usage (read-only)');
  const result = await hostModule(DISK_USAGE_MODULE, {
    top: 10,
    timeoutS: 180,
  });
  for (const line of result.report || []) console.log(line);
  fs.mkdirSync('data', { recursive: true });
  const file = `data/disk-usage-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  fs.writeFileSync(file, JSON.stringify(result, null, 2) + '\n');
  console.log(`>>> Disk usage report written to ${file}`);
  process.exit(0);
}

// --diagnose: who uses the machine now and on whose behalf; nothing else runs.
if (config.diagnose) {
  nextStep(
    `Diagnosing resource use over ${config.diagnoseSeconds}s (read-only)`
  );
  const result = await hostModule(DIAGNOSE_MODULE, {
    seconds: config.diagnoseSeconds,
    top: 8,
    hogPercent: config.cpuHogPercent,
    hogMinutes: config.cpuHogMinutes,
  });
  for (const line of result.summary || []) console.log(line);
  for (const line of sinceLastDiagnosis(result)) console.log(line);
  console.log('');
  for (const line of result.report) console.log(line);
  // A busy Formal AI sidecar: its clients' runs show whether a task loops.
  const executions = result.groups
    .filter((g) => g.role === 'formal-ai' && g.cores >= 0.5)
    .flatMap((g) => g.clients || [])
    .map(
      (name) => result.groups.find((g) => g.container === name)?.task?.execution
    )
    .filter(Boolean);
  if (executions.length)
    console.log(
      `>>> Formal AI is busy: to check its client task(s) for tool-call loops, run ./auto-fix.mjs --collect ${executions.join(' ')}`
    );
  console.log('--- Stuck uploads (gh-upload-log/sanitizer, report only)');
  result.stuckUploads = await checkStuckUploads({ kill: false });
  console.log('--- Browsers and Formal AI clients of the tasks (report only)');
  result.tasks = await checkTasks({ kill: false });
  result.toolServices = await checkToolServices({ act: false }).catch(
    (error) => ({ clean: false, error: error.message })
  );
  result.globalTools = await checkGlobalTools({ act: false }).catch((error) => {
    console.log(
      `>>> Could not audit global tool configuration: ${error.message}`
    );
    return { clean: false, error: error.message };
  });
  fs.mkdirSync('data', { recursive: true });
  const file = `data/diagnose-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  fs.writeFileSync(file, JSON.stringify(result, null, 2) + '\n');
  console.log(`>>> Diagnosis written to ${file}`);
  process.exit(0);
}

// --check-tasks: only the task check (stuck browsers, Formal AI clients).
if (config.checkTasks) {
  nextStep(
    `Checking the tasks for unused browsers${config.killStuckBrowsers ? '' : config.dryRun ? ' (dry run)' : ' (report only)'}`
  );
  const result = await checkTasks();
  process.exit(result ? 0 : 1);
}

// --collect / --collect-matching: data of chosen executions, successful ones
// too, and nothing else (no start, recovery, report or cleanup).
const collectIds = (config.collect || [])
  .flatMap((id) => String(id).split(/[\s,]+/))
  .filter(Boolean);
if (collectIds.length || config.collectMatching) {
  nextStep(
    `Collecting ${[collectIds.length ? collectIds.length + ' execution(s)' : null, config.collectMatching ? `executions matching /${config.collectMatching}/ of the last ${config.sinceHours}h` : null].filter(Boolean).join(' and ')}${config.reportDry ? ' (dry run: no upload)' : ''}`
  );
  const { collected, botLog } = await containerModule(REPORT_MODULE, {
    mode: 'collect',
    ids: collectIds,
    match: config.collectMatching || null,
    sinceMs: Date.now() - config.sinceHours * 3600000,
    dry: config.reportDry,
    repo: config.reportRepo,
    reportFailed: config.reportFailed,
    publicLogs: config.publicLogs,
  });
  if (!collected.length) console.log('>>> No execution matched');
  for (const c of collected) {
    if (c.error && !c.uuid) {
      console.log(`>>>   ${c.id}: ${c.error}`);
      continue;
    }
    console.log(
      `>>>   ${c.uuid} ${c.url || c.sessionName || ''}${c.tool ? ' --tool ' + c.tool : ''}${c.model ? ' --model ' + c.model : ''}`
    );
    if (c.error) {
      console.log(`>>>     ${c.error}`);
      continue;
    }
    console.log(
      `>>>     ${c.outcome}: status ${c.status}, exit ${c.exitCode ?? '?'}, ${c.startTime || '?'} → ${c.endTime || 'running'}${c.reported === true ? `, failure reported${c.reportedAt ? ' (' + c.reportedAt.join(', ') + ')' : ''}` : c.reported === false ? ', failure NOT reported yet (a full run reports it)' : ''}`
    );
    if (c.note) console.log(`>>>     ${c.note}`);
    if (c.log) console.log(`>>>     log: ${c.log}`);
    for (const line of c.signals || []) console.log(`>>>     | ${line}`);
    for (const line of c.suspect || [])
      console.log(`>>>     ⚠️ suspect: ${line}`);
    if (c.searchError) console.log(`>>>     ⚠️ ${c.searchError}`);
  }
  if (botLog) console.log(`>>> Bot log: ${botLog}`);
  fs.mkdirSync('data', { recursive: true });
  const file = `data/collected-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  fs.writeFileSync(file, JSON.stringify({ collected, botLog }, null, 2) + '\n');
  console.log(`>>> Collected data written to ${file}`);
  process.exit(
    collected.some((c) => c.error || /^upload failed/.test(c.log || '')) ||
      /^upload failed/.test(botLog || '')
      ? 1
      : 0
  );
}

nextStep(`Diagnosing what failed (last ${config.sinceHours}h)`);
await hostScript(
  `
since="-${Number(config.sinceHours)}h"
echo "--- uptime / boots"
uptime
last -x reboot | head -3
echo "--- host-wide OOM kills (the kernel killed a process to save the host)"
# -k is the current boot only; the kernel transport covers earlier boots too.
journalctl _TRANSPORT=kernel --since "$since" --no-pager -o short-iso | grep -E "Out of memory: Killed process" || echo "none"
echo "--- per-container OOM kills: $(journalctl _TRANSPORT=kernel --since "$since" --no-pager | grep -c "Memory cgroup out of memory")"
journalctl _TRANSPORT=kernel --since "$since" --no-pager -o short-iso | grep -E "Memory cgroup out of memory: Killed process" | sed -E 's/ total-vm.*//' | tail -10
echo "--- boots that ended without a shutdown (hard reset: hypervisor, power, kernel hang)"
journalctl --list-boots -o json --no-pager | python3 -c '
import json, sys, time
boots = json.load(sys.stdin)
for b in boots[:-1]:
    if b["last_entry"] / 1e6 > time.time() - ${Number(config.sinceHours)} * 3600:
        print(b["boot_id"], time.strftime("%Y-%m-%dT%H:%M:%S%z", time.localtime(b["last_entry"] / 1e6)))
' | while read -r b at; do
  journalctl -b "$b" -n 15 --no-pager -q | grep -qE "Journal stopped|systemd-shutdown|Reached target .*(Shutdown|Power-Off|Reboot)" ||
    echo "boot $b: journal stops at $at without a shutdown"
done
echo "--- docker daemon crashes / restarts"
journalctl -u docker --since "$since" --no-pager -o short-iso | grep -E "killed by the OOM killer|Main process exited|Scheduled restart|Started docker.service" || echo "none"
echo "--- memory / disk"
free -h
df -h /
`,
  { show: true }
);
console.log('--- CPU (sampled now)');
await checkCpu();
console.log('--- Stuck uploads (gh-upload-log/sanitizer)');
await checkStuckUploads();
console.log('--- Browsers and Formal AI clients of the tasks');
await checkTasks();

nextStep('Ensuring the Docker daemon is running');
const dockerActive = (
  (
    await ssh('systemctl is-active docker', {
      silent: true,
      ignoreErrors: true,
    })
  ).stdout || ''
).trim();
console.log(`>>> docker.service: ${dockerActive || 'unknown'}`);
if (dockerActive !== 'active') {
  if (config.dryRun) {
    console.log(
      '>>> Dry run: would start docker.service; nothing more can be checked without it'
    );
    process.exit(1);
  }
  await ssh('systemctl start docker');
}
for (let waited = 0; ; waited += 5) {
  const info = await ssh('docker info --format {{.ServerVersion}}', {
    silent: true,
    ignoreErrors: true,
  });
  if ((info.stdout || '').trim()) {
    console.log(`>>> Docker daemon is up (version ${info.stdout.trim()})`);
    break;
  }
  if (waited >= 120) {
    console.error('>>> ERROR: Docker daemon did not come up within 120s');
    process.exit(1);
  }
  await sleep(5000);
}
// Without live-restore, a dockerd restart kills every container: that is what
// turned the 2026-10-09 dockerd OOM kill into a full outage. Report only; the
// deploy script (deploy-remote-docker.mjs) is what turns it on.
const liveRestore = (
  (
    await ssh(`docker info -f '{{.LiveRestoreEnabled}}'`, {
      silent: true,
      ignoreErrors: true,
    })
  ).stdout || ''
).trim();
if (liveRestore === 'true') {
  console.log(
    '>>> Docker live-restore is enabled (containers survive a dockerd restart)'
  );
} else if (config.fixLiveRestore) {
  // Reloadable option: SIGHUP via `systemctl reload`; a restart would kill every container.
  const merged = await ssh(
    `python3 -c 'import json,os
p="/etc/docker/daemon.json"
d=json.load(open(p)) if os.path.exists(p) and os.path.getsize(p) else {}
d["live-restore"]=True
os.makedirs("/etc/docker",exist_ok=True)
open(p,"w").write(json.dumps(d,indent=2)+"\\n")' && systemctl reload docker && sleep 2 && docker info -f '{{.LiveRestoreEnabled}}'`,
    { silent: true, ignoreErrors: true }
  );
  if ((merged.stdout || '').trim().endsWith('true'))
    console.log(
      '>>> Docker live-restore enabled via reload (no container was restarted)'
    );
  else
    console.log(
      `>>> WARNING: could not enable Docker live-restore (is /etc/docker/daemon.json valid JSON?): ${(merged.stderr || '').trim()}`
    );
} else {
  console.log(
    '>>> WARNING: Docker live-restore is disabled: the next dockerd restart will kill every container again.'
  );
  console.log(
    '>>>          Set "live-restore": true in /etc/docker/daemon.json and `systemctl reload docker` (never restart).'
  );
}

nextStep('Container states');
await ssh(`docker ps -a --format '{{.Names}}\\t{{.Status}}\\t{{.Image}}'`);

nextStep(
  `Starting the ${CONTAINER} container (never removed: it holds the bot's state)`
);
const status = await getContainerStatus();
console.log(`>>> Container status: ${status}`);
if (status === 'not_found') {
  console.error(
    `>>> ERROR: ${CONTAINER} container does not exist. Its state is gone, so there is nothing to recover;`
  );
  console.error(
    '>>> redeploy with ./deploy-remote-docker.mjs and restart the tasks from Telegram.'
  );
  process.exit(1);
}
if (status === 'unknown') {
  console.error(
    `>>> ERROR: Could not read the ${CONTAINER} container status over SSH; nothing was changed. Run this script again.`
  );
  process.exit(1);
}
if (status !== 'running') {
  if (config.dryRun) {
    console.log(
      `>>> Dry run: would start the ${CONTAINER} container (${status}); nothing more can be checked without it`
    );
    process.exit(1);
  }
  await ssh(`docker start ${CONTAINER}`);
}
const startedAt = (
  (
    await ssh(`docker inspect -f {{.State.StartedAt}} ${CONTAINER}`, {
      silent: true,
    })
  ).stdout || ''
).trim();
if ((await getContainerStatus()) !== 'running') {
  console.error(`>>> ERROR: ${CONTAINER} failed to start`);
  await ssh(`docker logs --tail 50 ${CONTAINER}`, { ignoreErrors: true });
  process.exit(1);
}
console.log(`>>> ${CONTAINER} is running (started ${startedAt})`);

nextStep('Checking for idle tool services that block the queue');
await checkToolServices();

nextStep('Enforcing the server-global Claude/Codex baseline');
await checkGlobalTools();

nextStep('Waiting for the bot to poll Telegram');
let botStarted = false;
for (let waited = 0; waited < 180; waited += 5) {
  const logs = await ssh(
    `docker logs --since ${startedAt} ${CONTAINER} 2>&1 | grep -m1 -iE 'Polling is active|starting polling'`,
    { silent: true, ignoreErrors: true }
  );
  if ((logs.stdout || '').trim()) {
    botStarted = true;
    break;
  }
  await sleep(5000);
}
if (!botStarted) {
  console.error('>>> ERROR: Bot did not start polling within 180s');
  await ssh(`docker logs --tail 50 ${CONTAINER}`, { ignoreErrors: true });
  process.exit(1);
}
console.log('>>> Bot is polling Telegram');

nextStep('Rebuilding the solve queue the bot lost');
// The queue lives only in the bot's memory. Its log keeps every lifecycle
// line and the raw Telegram command, so replay the last bot run before this
// start and keep the items that never started.
const queueLog = await ssh(
  `docker logs --until ${startedAt} ${CONTAINER} 2>&1 | grep -aE "(Enqueued|Starting|Cancelled queued item|Rejected queued item): \\[solve-|SolveQueue initialized| raw text: "`,
  { silent: true, ignoreErrors: true }
);
// What the current bot run queued or started again. Its lines can be only in
// the bot's own log file (/home/box/hive-telegram-bot.log), not in `docker
// logs`; the file may hold earlier runs too, so only lines after its last
// `SolveQueue initialized` count.
const requeued = await ssh(
  `{ docker logs --since ${startedAt} ${CONTAINER} 2>&1; docker exec ${CONTAINER} sh -c 'f=/home/box/hive-telegram-bot.log; [ -f "$f" ] && n=$(grep -an "SolveQueue initialized" "$f" | tail -1 | cut -d: -f1) && tail -n +"\${n:-1}" "$f"'; } | grep -aoE "(Enqueued|Starting): \\[solve-[^]]+\\] [^ ]+"`,
  { silent: true, ignoreErrors: true }
);
{
  const lines = (queueLog.stdout || '').split('\n');
  const lastRun =
    lines
      .map((l, i) => (l.includes('SolveQueue initialized') ? i : -1))
      .filter((i) => i >= 0)
      .pop() ?? 0;
  const alreadyRequeued = new Set(
    (requeued.stdout || '')
      .split('\n')
      .map((l) => l.split(' ').pop())
      .filter(Boolean)
  );
  const items = new Map();
  let lastRawText = new Map();
  for (const line of lines.slice(lastRun)) {
    const raw = / raw text: (\/\S+ (\S+).*)$/.exec(line);
    if (raw) {
      lastRawText.set(raw[2], raw[1].replace(/—/g, '--'));
      continue;
    }
    const event =
      /(Enqueued|Starting|Cancelled queued item|Rejected queued item): \[(solve-[\w-]+)\] (\S+)(?:.* to (\w+) queue)?/.exec(
        line
      );
    if (!event) continue;
    const [, kind, id, url, tool] = event;
    if (kind === 'Enqueued')
      items.set(id, {
        url,
        tool,
        command: lastRawText.get(url) || null,
        pending: true,
      });
    else if (items.has(id)) items.get(id).pending = false;
  }
  const lost = [...items.values()].filter(
    (item) => item.pending && !alreadyRequeued.has(item.url)
  );
  if (lost.length === 0) {
    console.log('>>> No queued items were lost');
  } else {
    // A new file only when the list changed since the last run.
    const content =
      lost
        .map((item) => item.command || `/${item.tool} ${item.url}`)
        .join('\n') + '\n';
    fs.mkdirSync('data', { recursive: true });
    const previous = fs
      .readdirSync('data')
      .filter((f) => /^recovered-queue-.*\.txt$/.test(f))
      .sort()
      .pop();
    let file =
      previous && fs.readFileSync(`data/${previous}`, 'utf8') === content
        ? `data/${previous}`
        : null;
    if (!file) {
      file = `data/recovered-queue-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`;
      fs.writeFileSync(file, content);
    }
    console.log(
      `>>> ${lost.length} queued item(s) were lost with the bot's memory (${[...new Set(lost.map((i) => i.tool))].map((t) => `${t}: ${lost.filter((i) => i.tool === t).length}`).join(', ')}).`
    );
    console.log(
      `>>> Their original commands are in ${file}; paste them into the Telegram chat to queue them again:`
    );
    for (const item of lost)
      console.log(`>>>   ${item.command || `/${item.tool} ${item.url}`}`);
  }
}

nextStep('Claude Code sessions that were active in the root container');
await hostScript(
  `
find /root/.hive-mind/claude/projects -maxdepth 2 -name '*.jsonl' -size +200k -newermt "@${Math.floor(Date.now() / 1000 - config.sinceHours * 3600)}" ! -newermt "@${Math.floor(Date.parse(startedAt) / 1000)}" 2>/dev/null |
while read -r f; do
  # Claude's project dir name is the cwd with every / replaced by -; a dash
  # in the path cannot be told apart, so print it as is.
  project=$(basename "$(dirname "$f")")
  echo ">>>   $(date -u -r "$f" +%FT%TZ) $project  claude --resume $(basename "$f" .jsonl)"
done
`,
  { show: true }
);
console.log(
  '>>> These are interactive sessions; resume them by hand inside the container if they are still needed.'
);

// Running executions the bot does not track: followed until they end.
const followed = new Set();
nextStep(
  config.repairRecords
    ? 'Repairing start-command records and completion watchers'
    : 'Checking start-command records (--no-repair-records)'
);
try {
  for (const uuid of await repairRecords()) followed.add(uuid);
  console.log(
    `>>> ${followed.size} running task(s) not tracked by the bot${followed.size ? ' (followed until they end)' : ''}`
  );
} catch (error) {
  console.log(`>>> Could not check records: ${error.message}`);
}

if (config.report) {
  // Before any cleanup: the stopped containers and logs are the evidence.
  nextStep(
    `Reporting dead tasks to ${config.reportRepo}${config.reportDry ? ' (dry run: previews only)' : ''}`
  );
  try {
    await reportDeadTasks();
  } catch (error) {
    console.log(`>>> Could not report dead tasks: ${error.message}`);
  }
  if (config.cleanup && !config.reportDry) {
    await cleanReportedFailed().catch((error) =>
      console.log(
        `>>> Could not clean up reported failed tasks: ${error.message}`
      )
    );
  }
}

nextStep(
  [
    config.resume
      ? 'Resuming killed tasks'
      : 'Reporting killed tasks (--no-resume)',
    config.cleanup ? 'cleaning up finished ones' : null,
    'monitoring',
  ]
    .filter(Boolean)
    .join(', ')
);
const botStartMs = Date.parse(startedAt);
const deadline = Date.now() + config.waitMinutes * 60000;
// With --no-resume nothing here resumes a task: one that needs it is reported
// and listed, and waiting for it would only run out the --wait-minutes clock.
const ACTIVE = new Set([
  ...(config.resume ? ['needs-resume'] : []),
  'resuming',
  'bot-recovering',
]);
// Writable-layer size of a stopped container, read from the containerd
// snapshotter on the host (not through dockerd, which would walk the image).
const layerBytes = new Map();
const measureLayer = async (name) => {
  // Retried: the walk fails when a file vanishes during it.
  const result = await hostScript(
    `id=$(docker inspect -f '{{.Id}}' ${name}) && for i in 1 2 3 4; do out=$(nice ionice -c3 ctr -n moby snapshots --snapshotter overlayfs usage "$id" 2>/dev/null | tail -1); echo "$out " | grep -qE '[0-9] (B|KiB|MiB|GiB|TiB) ' && break; done; echo "$out "`,
    { ignoreErrors: true }
  );
  const match = /\s([\d.]+)\s*(KiB|MiB|GiB|TiB)\s/.exec(result.stdout || '');
  if (!match) return null;
  return (
    Number(match[1]) * 2 ** { KiB: 10, MiB: 20, GiB: 30, TiB: 40 }[match[2]]
  );
};

for (;;) {
  const health = await hostScript(`
echo "disk_free_gb=$(df -BG --output=avail / | tail -1 | tr -dc 0-9)"
echo "mem_available_mb=$(free -m | awk '/^Mem:/{print $7}')"
echo "dockerd_rss_mb=$(( $(ps -o rss= -C dockerd | sort -n | tail -1) / 1024 ))"
echo "snapshots_running=$(pgrep -fc '^docker commit ')"
`);
  const metrics = Object.fromEntries(
    (health.stdout || '')
      .trim()
      .split('\n')
      .map((l) => l.split('='))
      .filter((p) => p.length === 2)
      .map(([k, v]) => [k, Number(v)])
  );
  const now = new Date().toISOString().slice(11, 19);
  console.log(
    `\n>>> [${now}Z] disk free ${metrics.disk_free_gb} GB, memory available ${metrics.mem_available_mb} MB, dockerd RSS ${metrics.dockerd_rss_mb} MB, snapshots running ${metrics.snapshots_running}`
  );
  if (metrics.disk_free_gb < config.minFreeGb) {
    console.log(
      `>>> WARNING: less than ${config.minFreeGb} GB free; snapshots of large task containers may fill the disk`
    );
  }
  if (metrics.dockerd_rss_mb > config.maxDockerdRssGb * 1024) {
    console.log(
      `>>> WARNING: dockerd uses more than ${config.maxDockerdRssGb} GB; a host OOM would kill every container again`
    );
  }
  await checkCpu({ brief: true });
  await checkStuckUploads({ brief: true });
  await checkTasks({ brief: true });
  await checkGlobalTools({ brief: true });
  await checkToolServices({ brief: true });

  const params = {
    act: false,
    cleanup: false,
    sinceMs: Date.now() - config.sinceHours * 3600000,
    botStartMs,
    graceMs: config.botGraceMinutes * 60000,
    maxResumes: config.maxResumes,
  };
  let tasks = [];
  let cleaned = [];
  let lockNote = null;
  let readOk = false;
  try {
    ({ tasks } = await containerModule(RECOVERY_MODULE, params));
    readOk = true;
    if (config.resume || config.cleanup) {
      // A full snapshot needs room for the compressed blob and the unpacked
      // copy, so allow only the smallest one that fits, and only one at a time.
      const deferReasons = {};
      const fits = [];
      for (const task of tasks.filter(
        (t) => t.state === 'needs-resume' && t.exitCode === 137
      )) {
        if (!layerBytes.has(task.name))
          layerBytes.set(task.name, await measureLayer(task.name));
        const bytes = layerBytes.get(task.name);
        const needGb =
          bytes === null
            ? null
            : Math.ceil((1.5 * bytes) / 2 ** 30 + config.snapshotHeadroomGb);
        if (metrics.snapshots_running > 0)
          deferReasons[task.name] = 'another snapshot is running';
        else if (needGb === null)
          deferReasons[task.name] = 'writable layer size unknown';
        else if (metrics.disk_free_gb < needGb)
          deferReasons[task.name] =
            `snapshot of ${(bytes / 2 ** 30).toFixed(1)} GiB layer needs ${needGb} GB free, ${metrics.disk_free_gb} GB available`;
        else fits.push({ name: task.name, bytes });
      }
      fits.sort((a, b) => a.bytes - b.bytes);
      for (const other of fits.slice(1))
        deferReasons[other.name] = 'waiting for the smaller snapshot to finish';
      ({ tasks, cleaned, lockNote } = await containerModule(RECOVERY_MODULE, {
        ...params,
        act: config.resume,
        cleanup: config.cleanup,
        allowSnapshotNames: fits.slice(0, 1).map((f) => f.name),
        deferReasons,
      }));
    }
  } catch (error) {
    console.log(`>>> Could not read task state: ${error.message}`);
  }
  if (lockNote) console.log(`>>> ${lockNote}`);
  for (const line of cleaned) console.log(`>>>   cleaned up ${line}`);
  for (const task of tasks.filter((t) => t.state !== 'completed')) {
    console.log(
      `>>>   ${task.url || task.name}  [${task.state}${task.resumes ? `, resumed ${task.resumes}x` : ''}]  ${task.name}: ${task.container || 'no container'}`
    );
    if (task.action) console.log(`>>>     ${task.action}`);
  }
  const completed = tasks.filter((t) => t.state === 'completed').length;
  if (completed)
    console.log(
      `>>>   (${completed} task(s) completed in the last ${config.sinceHours}h not shown)`
    );
  const kept = tasks.filter((t) => /^exited-/.test(t.state) && t.container);
  if (kept.length)
    console.log(
      `>>>   ${kept.length} failed task container(s) kept on disk: ${config.cleanup && !config.reportDry ? 'not reported yet, or holding unsaved Git work (see above)' : config.cleanup ? 'a --report-dry run cleans nothing up' : '--no-cleanup'}`
    );

  for (const task of tasks) {
    if (task.action?.startsWith('resumed')) followed.add(task.uuid);
  }
  // A followed task has ended once its record is final: it is listed again,
  // neither running nor resuming. Right after its container exits the record
  // is still `executing` (start-command's watcher finalizes it moments later)
  // and the task is not listed at all; it stays followed until then. A poll
  // that could not read the state changes nothing.
  const isEnded = (uuid) =>
    tasks.some(
      (t) => t.uuid === uuid && t.state !== 'running' && t.state !== 'resuming'
    );
  const ended = config.follow && readOk ? [...followed].filter(isEnded) : [];
  const following = config.follow
    ? [...followed].filter((uuid) => !ended.includes(uuid))
    : [];
  if (ended.length) {
    for (const uuid of ended) followed.delete(uuid);
    console.log(`>>> ${ended.length} followed task(s) ended`);
    if (config.report)
      await reportDeadTasks().catch((error) =>
        console.log(`>>> Could not report dead tasks: ${error.message}`)
      );
    if (config.report && config.cleanup && !config.reportDry) {
      await cleanReportedFailed().catch((error) =>
        console.log(
          `>>> Could not clean up reported failed tasks: ${error.message}`
        )
      );
    }
    if (config.cleanup) {
      await sleep(config.pollSeconds * 1000); // one more poll cleans them up
      continue;
    }
  }
  if (readOk && !tasks.some((t) => ACTIVE.has(t.state)) && !following.length) {
    console.log(
      `>>> Nothing left to recover: ${tasks.filter((t) => t.state === 'running').length} task(s) running${config.follow ? ', all tracked by the bot' : ''}`
    );
    break;
  }
  if (following.length) {
    console.log(
      `>>> Following ${following.length} task(s) the bot does not track: ${following
        .map((uuid) => {
          const t = tasks.find((x) => x.uuid === uuid);
          return t ? t.url || t.name : uuid + ' (finishing)';
        })
        .join(', ')}`
    );
    if (config.repairRecords)
      await repairRecords().catch((error) =>
        console.log(`>>> Could not check records: ${error.message}`)
      );
  }
  if (Date.now() > deadline) {
    console.log(
      `>>> Stopped monitoring after ${config.waitMinutes} min; recovery continues on the server. Re-run this script to keep going.`
    );
    process.exitCode = 2;
    break;
  }
  await sleep(config.pollSeconds * 1000);
}

if (config.dssClean) {
  nextStep(
    `Safe disk cleanup with disk-space-saviour ${DSS.version}${config.dssDry ? ' (dry run)' : ''}: host, then every running container`
  );
  try {
    const result = await hostModule(DISK_CLEAN_MODULE, {
      ...DSS,
      dry: config.dssDry,
      hostTimeoutS: 1800,
      containerTimeoutS: 900,
      minItemMb: 20,
      journalKeepDays: config.journalKeepDays,
      maxDockerdRssMb: 2560,
      minMemAvailableMb: 1536,
    });
    const gib = (bytes) => (bytes / 2 ** 30).toFixed(2) + ' GiB';
    console.log(
      `>>>   host: ${result.host.error ? 'error ' + result.host.error : (config.dssDry ? 'would free ' : 'freed up to ') + gib(result.host.bytes) + ' in ' + result.host.items + ' item(s)'}`
    );
    for (const c of result.containers) {
      if (c.error && !c.candidates) {
        console.log(`>>>   ${c.name}: ${c.error}`);
        continue;
      }
      console.log(
        `>>>   ${c.name}: ${config.dssDry ? 'would delete ' : 'deleted ' + c.deleted + ' item(s), '}${gib(c.bytes)} in its writable layer (${c.candidates} safe item(s) found${c.blocked ? ', ' + c.blocked + ' blocked by dss' : ''})${c.error ? '; ' + c.error : ''}`
      );
      for (const line of c.top || []) console.log(`>>>     ${line}`);
    }
    if (result.journal) console.log(`>>>   journal: ${result.journal}`);
    for (const note of result.notes) console.log(`>>>   ${note}`);
    console.log(
      `>>>   free disk now ${gib(result.freeBytes)} (${result.freedBytes >= 0 ? '+' : ''}${gib(result.freedBytes)})`
    );
  } catch (error) {
    console.log(`>>> Disk cleanup failed: ${error.message}`);
  }
}

console.log('>>> Done');
console.log(
  `>>> Enter the bot container: ssh to server, then: docker exec -it ${CONTAINER} /bin/bash`
);
