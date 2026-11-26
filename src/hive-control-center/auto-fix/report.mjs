// Runs inside the hive-mind container (as the bot user) via auto-fix.mjs, which
// prepends `const PARAMS = {...};`. Reports dead tasks to the hive-mind
// repository on GitHub, once per task attempt.
//
// PARAMS.mode 'candidates': lists the task attempts that died in the last
// PARAMS.sinceMs window, or whose stopped container is still on disk however
// old it is, and were not reported yet. An attempt is reportable when it was
// killed (exit >= 128, an OOM or kill exit reason), when its program was not
// found (127), when it was a recovery run that failed, when it is lost (its
// record says executing, but no container or watcher is left), or, with
// PARAMS.reportFailed (auto-fix's default), on any other non-zero exit.
//
// PARAMS.mode 'reported-dead': lists the failed executions whose dead attempts
// are all reported and whose containers are all stopped, except killed ones
// still to be resumed; auto-fix removes their containers once it has checked
// that no Git work is left in them.
//
// PARAMS.mode 'report': PARAMS.events are those candidates, PARAMS.factsPath
// the facts host-facts.mjs collected on the host. Each attempt is analyzed
// (`$ --status`, the end of its start-command log, hive-mind recovery and
// lifecycle lines, Docker's own log, the kernel and daemon journal, the work
// left in its Git work dirs) and given a signature. One issue or comment is
// written per signature:
//   - an attempt already reported (the local state file, or its execution UUID
//     found by a GitHub search of issue bodies and comments) is skipped;
//   - a signature of a known open issue gets a comment there; a closed one
//     gets a new issue that references it (a possible regression), unless it
//     was closed after the installed hive-mind was released: then the fix is
//     just not deployed yet, and the attempt is recorded without a report;
//   - otherwise an open `[auto-fix] ...` issue with the same title gets a
//     comment, or a new issue is created.
// PARAMS.mode 'collect': PARAMS.ids (execution UUIDs or session names) and
// PARAMS.match (a pattern for the command, over PARAMS.sinceMs) pick
// executions, successful ones too; each is confirmed with `$ --list` and
// `$ --status`, its log uploaded with `$ --upload-log`, and the lines that
// tell how it ended are returned (auto-fix --collect / --collect-matching),
// with suspected false successes (one or two turns, "No changes were
// produced") and tool-call loops, and whether a failure is already reported
// (state, or a GitHub search for the execution UUID).
//
// Execution logs are uploaded with `$ --upload-log` (start-command 0.37+
// sanitizes them and uploads privately); the bot log, public uploads and older
// start-command releases use hive-mind's own sanitizing uploader. Private
// unless PARAMS.publicLogs.
// Every body passes hive-mind's fail-closed publication sanitizer; a body it
// blocks is not posted. With PARAMS.dry nothing is uploaded or posted: the
// bodies are written to /tmp/auto-fix/report-preview-*.md instead.
// Prints one AF_JSON line.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execSync, execFileSync, spawnSync } from 'node:child_process';

const sh = (command) => execSync(command, { shell: '/bin/bash', encoding: 'utf8' }).trim();
const run = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, timeout: 600000, ...opts });
  return { code: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
};
const startCommand = sh("command -v '$'");
const STATE = process.env.HOME + '/.hive-mind/state/auto-fix-reports.json';
const BOT_LOG = process.env.HOME + '/hive-telegram-bot.log';
// The bot log is hundreds of MB and the sanitizer can spend many minutes on
// it. The execution logs carry the failure details; the bot log only gives
// context, so upload a bounded tail instead of the whole file.
const MAX_BOT_LOG_BYTES = 32 * 1024 ** 2;
const botLogForUpload = () => {
  try {
    const size = fs.statSync(BOT_LOG).size;
    if (size <= MAX_BOT_LOG_BYTES) return { file: BOT_LOG, tail: false };
    const buffer = Buffer.alloc(MAX_BOT_LOG_BYTES);
    const fd = fs.openSync(BOT_LOG, 'r');
    let read = 0;
    try {
      while (read < MAX_BOT_LOG_BYTES) {
        const n = fs.readSync(fd, buffer, read, MAX_BOT_LOG_BYTES - read, size - MAX_BOT_LOG_BYTES + read);
        if (!n) break;
        read += n;
      }
    } finally {
      fs.closeSync(fd);
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-bot-log-'));
    const file = path.join(dir, 'tail.log');
    fs.writeFileSync(file, buffer.subarray(0, read), { mode: 0o600 });
    return { file, tail: true };
  } catch {
    return { file: BOT_LOG, tail: false };
  }
};
const readState = () => {
  try {
    return JSON.parse(fs.readFileSync(STATE, 'utf8'));
  } catch {
    return { reported: {} };
  }
};
const state = readState();
// Reports are tracked per target repository, so a run against another repo
// (a test sandbox) never hides an attempt from the real one. Entries written
// before that are plain keys, matched by their issue URL.
const stateKey = (key) => PARAMS.repo + ' ' + key;
const isReported = (key) => !!state.reported[stateKey(key)] || String(state.reported[key]?.url || '').includes('github.com/' + PARAMS.repo + '/');
const markReported = (key, entry) => {
  state.reported[stateKey(key)] = entry;
};

const listJson = (args) => {
  const out = execFileSync(startCommand, args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  return JSON.parse(out.slice(out.indexOf('{')));
};
// `$ --upload-log <execution>` uploads a sanitized copy of the execution's log,
// privately, since start-command 0.37 (it is told apart by its `--help`).
// Older releases uploaded the raw file: there, and for public uploads,
// hive-mind's own sanitizing uploader is used instead.
const startUploadSanitizes = /--upload-log <id>\s+Upload a sanitized copy/i.test(run(startCommand, ['--help']).out);
const uploadExecutionLog = (id) => {
  const r = run(startCommand, ['--upload-log', id], { timeout: 900000 });
  const url = (/🔗\s*(https:\/\/\S+)/.exec(r.out) || /(https:\/\/(?:gist\.)?github\.com\/\S+)/.exec(r.out) || [])[1] || null;
  return r.code === 0 && url ? { url } : { error: (r.err || r.out).split('\n').filter(Boolean).pop() || 'exit ' + r.code };
};
const solveUrl = (command) => (/(https:\/\/github\.com\/[^\s'"]+\/(?:issues|pull)\/\d+)/.exec(command || '') || [])[1] || null;
const argOf = (command, name) => (new RegExp(`'?--${name}'?[ =]'?([\\w.:/-]+)`).exec(command || '') || [])[1] || null;
// Only the fields used: `{{json .}}` also asks dockerd for every container's
// size, which walks each writable layer (slow, memory-hungry, and it fails
// while a task deletes files).
const containers = execFileSync('docker', ['ps', '-a', '--format', '{"Names":{{json .Names}},"State":{{json .State}},"Status":{{json .Status}}}'], { encoding: 'utf8' })
  .trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
const familyRoot = (e) => e.options?.sessionNameHistory?.[0] || e.options?.sessionName;
const family = (e) => containers.filter((c) => c.Names === familyRoot(e) || c.Names.startsWith(familyRoot(e) + '-resume-'));
const processes = execFileSync('ps', ['-eo', 'args'], { encoding: 'utf8' }).split('\n');
// A paused task is deliberately held, not dead: its container still exists and
// will run again on unpause, so reporting and cleanup must leave it alone.
const ACTIVE_STATES = new Set(['running', 'paused', 'restarting']);
const isActiveContainer = (c) => ACTIVE_STATES.has(c.State);

// One entry per attempt: `attemptHistory` holds the earlier attempts of a
// resumed execution; the current one is the record itself.
const attemptsOf = (e) => {
  const history = (Array.isArray(e.attemptHistory) ? e.attemptHistory : []).map((a) => ({ ...a, finishedAt: a.finishedAt || a.endTime, command: a.command || e.command }));
  const number = e.attempt?.number || history.length + 1;
  if (history.some((a) => a.number === number)) return history;
  return [...history, {
    ...(e.attempt || {}),
    number,
    status: e.status,
    exitCode: e.exitCode,
    exitReason: e.attempt?.exitReason || (e.oomKilled ? 'oom-killed' : null),
    sessionName: e.options?.sessionName,
    startedAt: e.attempt?.startedAt || e.startTime,
    finishedAt: e.status === 'executing' ? null : e.endTime,
    command: e.command,
    logOffset: e.attempt?.logOffset ?? e.logOffset ?? null,
  }];
};

// A user's /stop kills the container (exit 137) on purpose: the bot logs
// `session_stop_requested` for it, seconds before the attempt ends.
let stopEvents = null;
const stoppedByUser = (sessionName, finishedAt) => {
  if (!sessionName || !finishedAt) return false;
  if (!stopEvents) {
    stopEvents = run('grep', ['-F', 'EVENT session_stop_requested', BOT_LOG]).out.split('\n').map((l) => ({
      at: Date.parse(l.slice(0, 24)) || 0,
      name: (/"sessionName":"([^"]+)"/.exec(l) || [])[1],
    })).filter((s) => s.at && s.name);
  }
  const end = Date.parse(finishedAt) || 0;
  return stopEvents.some((s) => s.name === sessionName && s.at <= end + 60000 && s.at >= end - 10 * 60000);
};

const reasonOf = (e, a, lost) => {
  if (lost) return 'lost';
  const code = a.exitCode;
  if (code === 127) return 'program-not-found';
  if (code === 0 || code === null || code === undefined) return null;
  if (code >= 128 && stoppedByUser(a.sessionName || e.options?.sessionName, a.finishedAt)) return null;
  if (code >= 128 || /oom|kill/i.test(a.exitReason || '')) return 'killed';
  if (code !== 0 && code !== null && code !== undefined && a.number > 1) return 'recovery-failed';
  if (code !== 0 && code !== null && code !== undefined && PARAMS.reportFailed) return 'failed';
  return null;
};

if (PARAMS.mode === 'candidates') {
  const { executions = [] } = listJson(['--list', '--output-format', 'json']);
  const events = [];
  for (const e of executions) {
    if (e.options?.isolated !== 'docker' || e.options?.isolationMode !== 'detached') continue;
    const members = family(e);
    const lost = e.status === 'executing'
      && !members.some(isActiveContainer)
      && !processes.some((p) => p.includes('--resume ' + e.uuid) || (p.includes('docker logs -f') && p.includes(familyRoot(e))))
      && Date.now() - (Date.parse(e.startTime || '') || 0) > 10 * 60000;
    const attempts = attemptsOf(e);
    for (const a of attempts) {
      const isCurrent = a === attempts[attempts.length - 1];
      // A paused (or still running) task is held on purpose: an old attempt's
      // finishedAt must not turn its active container into a dead report.
      const own = members.find((c) => c.Names === (a.sessionName || e.options?.sessionName));
      if (own && isActiveContainer(own)) continue;
      const finished = Date.parse(a.finishedAt || '') || (lost && isCurrent ? Date.now() : 0);
      // A dead container left on disk is reported whenever it is found.
      const kept = members.some((c) => c.Names === (a.sessionName || e.options?.sessionName) && !isActiveContainer(c));
      if (finished < PARAMS.sinceMs && !kept) continue;
      const reason = reasonOf(e, a, lost && isCurrent);
      if (!reason) continue;
      const key = e.uuid + '#' + a.number;
      if (isReported(key)) continue;
      events.push({
        key,
        uuid: e.uuid,
        attempt: a.number,
        reason,
        status: e.status,
        exitCode: a.exitCode ?? null,
        exitReason: a.exitReason || null,
        sessionName: a.sessionName || e.options?.sessionName,
        startedAt: a.startedAt || e.startTime,
        finishedAt: a.finishedAt || null,
        command: a.command,
        url: solveUrl(e.command),
        logPath: e.logPath || null,
        logOffset: a.logOffset ?? null,
        containerNames: members.map((c) => c.Names),
      });
    }
  }
  console.log('AF_JSON:' + JSON.stringify({ events }));
} else if (PARAMS.mode === 'reported-dead') {
  const { executions = [] } = listJson(['--list', '--output-format', 'json']);
  // A killed task that auto-fix's recovery step (or the bot) still resumes
  // keeps its container: `$ --resume` restarts or snapshots it, so removing it
  // would lose the work and the agent's session. Same rule as recovery.mjs:
  // exit 137, or 127 from the alias bug, until the resume limit is reached or
  // a newer run of the same task finished with exit 0.
  const startedMs = (e) => Date.parse(e.startTime || '') || 0;
  const resumable = (e, last) => {
    const code = e.exitCode ?? last.exitCode;
    if (!(code === 137 || (code === 127 && /^\s*\//.test(e.command || '')))) return false;
    const url = solveUrl(e.command);
    if (!url) return false;
    if ((Number(e.options?.resumeCount) || 0) >= (PARAMS.maxResumes ?? Infinity)) return false;
    return !executions.some((other) => other !== e && other.exitCode === 0 && startedMs(other) > startedMs(e) && solveUrl(other.command) === url);
  };
  const dead = [];
  for (const e of executions) {
    if (e.options?.isolated !== 'docker' || e.options?.isolationMode !== 'detached' || e.status === 'executing') continue;
    const members = family(e);
    if (!members.length || members.some(isActiveContainer)) continue;
    const attempts = attemptsOf(e);
    const last = attempts[attempts.length - 1];
    if (!last || last.exitCode === 0 || last.exitCode === null || last.exitCode === undefined) continue;
    if (resumable(e, last)) continue;
    const reportable = attempts.filter((a) => reasonOf(e, a, false));
    if (!reportable.length || !reportable.every((a) => isReported(e.uuid + '#' + a.number))) continue;
    dead.push({
      uuid: e.uuid,
      url: solveUrl(e.command),
      finishedAt: e.endTime || null,
      containers: members.map((c) => c.Names),
      sessionNames: [...(e.options?.sessionNameHistory || []), e.options?.sessionName].filter(Boolean),
    });
  }
  console.log('AF_JSON:' + JSON.stringify({ dead }));
} else if (PARAMS.mode === 'collect') {
  // Any execution, successful ones too: each one is confirmed with `$ --list`
  // and `$ --status`, its log uploaded with `$ --upload-log` (private), and
  // the lines that tell how it really ended are returned. An exit 0 is not
  // proof of work done: the outcome lines show a session that changed nothing.
  const { executions = [] } = listJson(['--list', '--output-format', 'json']);
  const ids = new Set(PARAMS.ids || []);
  const match = PARAMS.match ? new RegExp(PARAMS.match, 'i') : null;
  const names = (e) => [e.uuid, e.options?.sessionName, ...(e.options?.sessionNameHistory || [])].filter(Boolean);
  // An id is a full UUID or session name, or a UUID prefix of 8+ hex chars
  // (as the bot shows them); a prefix matching several executions is refused.
  const hits = (id, e) => names(e).some((n) => n === id || (/^[0-9a-f-]{8,}$/i.test(id) && n.toLowerCase().startsWith(id.toLowerCase())));
  const collected = [];
  const byId = new Set();
  for (const id of ids) {
    const found = executions.filter((e) => hits(id, e));
    if (found.length === 1) byId.add(found[0]);
    else collected.push({ id, error: found.length ? `ambiguous: matches ${found.length} executions (${found.map((e) => e.uuid).join(', ')})` : 'not found by `$ --list`' });
  }
  const picked = executions.filter((e) => byId.has(e)
    || (match && match.test(e.command || '') && (Date.parse(e.startTime || '') || 0) >= PARAMS.sinceMs));
  for (const e of picked) {
    const entry = { uuid: e.uuid, url: solveUrl(e.command), tool: argOf(e.command, 'tool'), model: argOf(e.command, 'model'), sessionName: e.options?.sessionName || null };
    let status;
    try {
      status = listJson(['--status', e.uuid, '--output-format', 'json']);
    } catch (error) {
      collected.push({ ...entry, error: '`$ --status` failed: ' + (error.message || String(error)).split('\n')[0] });
      continue;
    }
    Object.assign(entry, { status: status.status, exitCode: status.exitCode ?? null, startTime: status.startTime || null, endTime: status.endTime || null });
    // A running execution is collected too: a session stuck in a loop may
    // never end (2026-10-20: Formal AI repeated one failing web_run call for
    // hours), so its log so far is checked and uploaded as a snapshot.
    const running = status.status === 'executing';
    if (running) entry.note = 'still running: the log is a snapshot so far; collect it again once it ends';
    entry.outcome = running ? 'running' : status.exitCode === 0 ? 'succeeded' : 'failed';
    let text = '';
    try {
      const fd = fs.openSync(status.logPath || e.logPath, 'r');
      const size = fs.fstatSync(fd).size;
      const buffer = Buffer.alloc(Math.min(size, 1024 * 1024));
      fs.readSync(fd, buffer, 0, buffer.length, size - buffer.length);
      fs.closeSync(fd);
      text = buffer.toString('utf8');
    } catch {}
    // Log lines of solve itself: JSON (tool output, API answers) and diff
    // lines quote other text, an issue body can say "No changes were produced".
    const own = text.split('\n').filter((l) => !/^\s*[[{}"\]]/.test(l) && !/"[a-z_]+":/.test(l) && !/^[-+]\s/.test(l));
    entry.signals = [...new Set(own
      .filter((l) => /🎉 SUCCESS|❌|🚨|No changes were produced|stays a draft|No progress|Session num_turns|command executions observed|Formal AI: serving backend|Runtime:|Reason:|Exit Code:|^(?:\S+Z )?(?:ba)?sh: .*: (?:No such file or directory|not found|command not found)$/.test(l))
      .map((l) => l.trim().slice(0, 300)))].slice(-15);
    // An exit 0 can still be a false success: a session of one or two turns
    // did no work, and the same shell command run again and again is a loop.
    entry.suspect = [];
    const turns = own.map((l) => /Session num_turns:\s*(\d+)/.exec(l)).filter(Boolean).map((m) => Number(m[1]));
    if (entry.outcome === 'succeeded' && turns.length && Math.max(...turns) <= 2) entry.suspect.push(`only ${Math.max(...turns)} turn(s): the session likely did no work`);
    if (entry.outcome === 'succeeded' && own.some((l) => /No changes were produced/.test(l))) entry.suspect.push('no changes were produced');
    // The loop can be anywhere in the log, so this reads all of it (up to 64 MB);
    // a tool logs each call more than once (started, completed), hence 20.
    let whole = text;
    try {
      const file = status.logPath || e.logPath;
      if (fs.statSync(file).size <= 64 * 1024 * 1024) whole = fs.readFileSync(file, 'utf8');
    } catch {}
    // A program that was not found (exit 127) is named far from the log's end.
    for (const m of whole.matchAll(/^(?:\S+Z )?((?:ba)?sh: .{1,200}: (?:No such file or directory|not found|command not found))$/gm)) if (!entry.signals.some((l) => l.endsWith(m[1]))) entry.signals.push(m[1]);
    // A usage limit can end a session with a bare "exit code 1": the API's
    // rejection is only in the --verbose SDK debug output (ANTHROPIC_LOG=debug)
    // and in the Claude session transcript, which the bot shares (~/.claude/projects).
    const rejected = [...whole.matchAll(/"anthropic-ratelimit-unified-status": "rejected"/g)].pop();
    if (rejected) {
      const near = whole.slice(Math.max(0, rejected.index - 1500), rejected.index + 1500);
      const claim = (/"anthropic-ratelimit-unified-representative-claim": "(\w+)"/.exec(near) || [])[1] || 'unknown';
      const reset = Number((/"anthropic-ratelimit-unified-reset": "(\d+)"/.exec(near) || [])[1]);
      entry.signals.push(`Anthropic API rejected requests: ${claim} usage limit used up${reset ? ', resets ' + new Date(reset * 1000).toISOString() : ''}`);
    }
    const claudeSession = [...whole.matchAll(/📌 Session ID: ([0-9a-f-]{36})/g)].pop()?.[1];
    if (claudeSession) {
      try {
        const projects = process.env.HOME + '/.claude/projects';
        const transcript = fs.readdirSync(projects).map((d) => `${projects}/${d}/${claudeSession}.jsonl`).find((f) => fs.existsSync(f));
        if (transcript) {
          const fd = fs.openSync(transcript, 'r');
          const size = fs.fstatSync(fd).size;
          const tail = Buffer.alloc(Math.min(size, 256 * 1024));
          fs.readSync(fd, tail, 0, tail.length, size - tail.length);
          fs.closeSync(fd);
          const last = tail.toString('utf8').split('\n').filter((l) => l.includes('"isApiErrorMessage":true')).pop();
          const message = last && JSON.parse(last);
          const text = message?.message?.content?.map?.((c) => c.text).filter(Boolean).join(' ');
          if (text) entry.signals.push(`Claude session ${claudeSession} ended with an API error at ${message.timestamp}: ${text.slice(0, 200)}`);
        }
      } catch {}
    }
    const commands = new Map();
    for (const m of whole.matchAll(/"(?:command|cmd)":"((?:[^"\\]|\\.){1,500})"/g)) commands.set(m[1], (commands.get(m[1]) || 0) + 1);
    // One call is often logged both wrapped (`/bin/bash -lc \"...\"`) and bare:
    // a command found inside a more frequent one is the same loop.
    const looping = [...commands].filter(([, count]) => count >= 20).sort((a, b) => b[1] - a[1]);
    const same = (a, b) => a.includes(b.replace(/\\"/g, '"')) || a.replace(/\\"/g, '"').includes(b.replace(/\\"/g, '"'));
    looping.filter(([command], i) => !looping.slice(0, i).some(([other]) => same(other, command)))
      .forEach(([command, count]) => entry.suspect.push(`the same command appears ${count} times in the log (tool-call loop?): ${command.slice(0, 120)}`));
    // MCP tool calls (Codex: `"type":"mcp_tool_call","server":…,"tool":…,"arguments":…`)
    // and the agent's own messages loop too; a call is logged started and completed.
    const repeats = (regex, key, min) => {
      const counts = new Map();
      for (const m of whole.matchAll(regex)) counts.set(key(m), (counts.get(key(m)) || 0) + 1);
      return [...counts].filter(([, count]) => count >= min).sort((a, b) => b[1] - a[1]).slice(0, 3);
    };
    repeats(/"type":"mcp_tool_call","server":"([^"]{1,100})","tool":"([^"]{1,200})","arguments":(\{[^{}]{0,300}\})/g, (m) => `${m[1]} ${m[2]} ${m[3]}`, 20)
      .forEach(([call, count]) => entry.suspect.push(`the same MCP tool call appears ${count} times in the log (tool-call loop?): ${call.slice(0, 160)}`));
    repeats(/"type":"agent_message","text":"((?:[^"\\]|\\.){1,300})"/g, (m) => m[1], 10)
      .forEach(([text, count]) => entry.suspect.push(`the agent said the same thing ${count} times (no progress?): ${text.slice(0, 160)}`));
    if (running || !e.uuid || e.exitCode === 0 || !reasonOf(e, attemptsOf(status).slice(-1)[0] || {}, false)) entry.reported = null;
    else entry.reported = attemptsOf(status).filter((a) => reasonOf(e, a, false)).every((a) => isReported(e.uuid + '#' + a.number));
    // Not in this host's state: it can still be reported on GitHub already, by
    // hand or from another host (the same search report mode does).
    if (entry.reported === false) {
      try {
        const out = execFileSync('gh', ['api', '-X', 'GET', 'search/issues', '-f', `q=${e.uuid} repo:${PARAMS.repo} in:body,comments`, '-q', '[.items[].html_url]'], { encoding: 'utf8', timeout: 60_000 });
        const urls = JSON.parse(out || '[]');
        if (urls.length) Object.assign(entry, { reported: true, reportedAt: urls });
      } catch (error) {
        entry.searchError = 'GitHub search failed: ' + (error.message || String(error)).split('\n')[0];
      }
    }
    if (PARAMS.dry) entry.log = 'not uploaded (dry run)';
    else if (!startUploadSanitizes) entry.log = 'not uploaded: this start-command uploads raw logs (needs 0.37+)';
    else {
      const up = uploadExecutionLog(e.uuid);
      entry.log = up.url || 'upload failed: ' + up.error;
    }
    collected.push(entry);
  }
  // The bot log tells what the bot did around the executions (queue, kill
  // notices, recovery): uploaded once, sanitized and private like in reports.
  let botLog = null;
  if (picked.length && !PARAMS.dry && fs.existsSync(BOT_LOG)) {
    try {
      let dir = path.dirname(fs.realpathSync(sh('command -v hive-telegram-bot')));
      while (dir !== '/' && !(fs.existsSync(dir + '/package.json') && JSON.parse(fs.readFileSync(dir + '/package.json', 'utf8')).name === '@link-assistant/hive-mind')) dir = path.dirname(dir);
      const { uploadLogWithGhUploadLog } = await import(dir + '/src/log-upload.lib.mjs');
      const uploadable = botLogForUpload();
      const result = await uploadLogWithGhUploadLog({ logFile: uploadable.file, isPublic: !!PARAMS.publicLogs, description: `hive-telegram-bot log${uploadable.tail ? ' tail' : ''} (auto-fix collect)` });
      botLog = result?.success ? result.url : 'upload failed';
    } catch (error) {
      botLog = 'upload failed: ' + (error.message || String(error)).split('\n')[0];
    }
  }
  console.log('AF_JSON:' + JSON.stringify({ collected, botLog }));
} else {
let dir = path.dirname(fs.realpathSync(sh('command -v hive-telegram-bot')));
while (dir !== '/' && !(fs.existsSync(dir + '/package.json') && JSON.parse(fs.readFileSync(dir + '/package.json', 'utf8')).name === '@link-assistant/hive-mind')) dir = path.dirname(dir);
const { uploadLogWithGhUploadLog } = await import(dir + '/src/log-upload.lib.mjs');
const { sanitizeForPublication } = await import(dir + '/src/token-sanitization.lib.mjs');
const hiveVersion = JSON.parse(fs.readFileSync(dir + '/package.json', 'utf8')).version;
const startVersion = run(startCommand, ['--version']).out.split('\n')[0].replace(/^.*version:?\s*/i, '');
const { system = {}, facts = {} } = PARAMS.factsPath && fs.existsSync(PARAMS.factsPath) ? JSON.parse(fs.readFileSync(PARAMS.factsPath, 'utf8')) : {};

// --- report-logic:start ---
// Read one attempt's slice of the shared execution log. `start` is the
// attempt's `logOffset`; without it, an attempt after the first is ambiguous
// and must not be classified from bytes that belong to an earlier attempt.
// `clipped` means the attempt is larger than the read budget, so the wrapper
// does not contain the whole interval Docker may still have.
const readWindow = (file, start, stop, bytes) => {
  try {
    const fd = fs.openSync(file, 'r');
    const { size } = fs.fstatSync(fd);
    const end = stop === null || stop === undefined || stop > size ? size : Math.max(0, stop);
    const rawStart = start === null || start === undefined ? null : Math.max(0, start);
    if (rawStart !== null && rawStart > end) {
      fs.closeSync(fd);
      return { size, start: rawStart, stop: end, from: end, text: '', bytes: 0, total: 0, clipped: false, ambiguous: true, invalid: true };
    }
    const begin = rawStart;
    const from = begin === null ? Math.max(0, end - bytes) : Math.max(begin, end - bytes);
    const length = Math.max(0, end - from);
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, from);
    fs.closeSync(fd);
    return {
      size,
      start: begin,
      stop: end,
      from,
      text: buffer.toString('utf8'),
      bytes: length,
      total: begin === null ? null : end - begin,
      clipped: begin !== null && from > begin,
      ambiguous: begin === null,
    };
  } catch {
    return { size: null, start: null, stop: null, from: null, text: '', bytes: 0, total: null, clipped: false, ambiguous: true };
  }
};
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
const shortHash = (value) => sha256(value).slice(0, 12);
const gb = (bytes) => (bytes / 2 ** 30).toFixed(1) + ' GiB';
const fence = (lines) => '```\n' + (lines.length ? lines.join('\n') : '(none)') + '\n```';
const clip = (line) => (line.length > 400 ? line.slice(0, 400) + ' …' : line);
const stripTs = (line) => line.replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z\s?/, '');
const dockerLineTime = (line) => Date.parse((/^\d{4}-\d\d-\d\dT[\d:.]+Z/.exec(line) || [])[0] || '') || null;
const attemptWindow = (attempt, now = Date.now()) => {
  const start = Date.parse(attempt?.startedAt || '') || null;
  let end = Date.parse(attempt?.finishedAt || '') || null;
  if (!end && attempt?.status === 'executing') end = now;
  return start && end && end >= start ? { start, end } : null;
};
const overlaps = (a, b) => !!a && !!b && a.start < b.end && b.start < a.end;

// A failure is recovered by a later attempt in the same execution or by a
// later execution of the same task. An execution that was already running when
// this attempt started can also finish successfully, but it did not recover
// this attempt: it superseded it. Keep those cases distinct so the report does
// not say "no recovery" when the task actually finished elsewhere.
const recoveryOutcome = (selected, ownLater = [], otherAttempts = []) => {
  const selectedWindow = attemptWindow(selected);
  const ownSuccess = ownLater.find((a) => a.exitCode === 0);
  const ownRunning = ownLater.find((a) => a.status === 'executing');
  if (ownSuccess) return 'yes: attempt ' + ownSuccess.number + ' finished with exit 0';
  if (ownRunning) return 'in progress: attempt ' + ownRunning.number + ' is running';
  const others = otherAttempts.filter((x) => x.window);
  const after = selectedWindow ? others.filter((x) => x.window.start >= selectedWindow.end) : [];
  const concurrent = selectedWindow ? others.filter((x) => overlaps(selectedWindow, x.window)) : [];
  const ref = (x) => '`' + x.e.uuid + '` attempt ' + x.a.number;
  const successAfter = after.find((x) => x.a.exitCode === 0);
  if (successAfter) return 'yes: ' + ref(successAfter) + ' finished with exit 0 after this attempt';
  const successConcurrent = concurrent.find((x) => x.a.exitCode === 0);
  if (successConcurrent) return 'yes: a concurrent execution finished with exit 0';
  const runningAfter = after.find((x) => x.a.status === 'executing');
  if (runningAfter) return 'in progress: ' + ref(runningAfter) + ' is running';
  const runningConcurrent = concurrent.find((x) => x.a.status === 'executing');
  if (runningConcurrent) return 'in progress: a concurrent execution is still running';
  if (ownLater.length) return 'no: ' + ownLater.length + ' later attempt(s) did not finish properly';
  return 'no recovery attempt on record';
};

// Docker's own log for the same time window. The host now captures both
// descriptors into one ordered stream; filtering by the attempt's timestamps
// keeps rows from another attempt out of this comparison.
const dockerLinesForAttempt = (f, ev) => {
  const rows = Array.isArray(f?.dockerLogs) ? f.dockerLogs : Array.isArray(f?.dockerLogsTail) ? f.dockerLogsTail : [];
  const start = Date.parse(ev.startedAt || '') || null;
  const end = Date.parse(ev.finishedAt || '') || null;
  if (!rows.length || !start || !end) return rows;
  const inside = rows.filter((line) => {
    const at = dockerLineTime(line);
    return !at || (at >= start - 1000 && at <= end + 1000);
  });
  return inside.length ? inside : rows;
};

// A missing row is evidence of a difference, not automatically of data loss:
// long JSON records, EOF fragments and a clipped wrapper interval are called
// out separately, with sizes and digests instead of the payload repeated.
const compareDocker = (wrapper, dockerRows, window, dockerMeta = {}) => {
  if (!dockerRows.length) return { status: 'no-docker-log', rows: 0, missing: [], reason: 'Docker log is unavailable' };
  if (window?.ambiguous) return { status: 'inconclusive', rows: dockerRows.length, missing: [], reason: 'the attempt start offset is unknown; the wrapper excerpt may contain an earlier attempt' };
  if (window?.clipped) return { status: 'inconclusive', rows: dockerRows.length, missing: [], reason: `the wrapper attempt is larger than the ${(window.bytes / 2 ** 20).toFixed(1)} MiB read window; its start is clipped` };
  const known = new Set(wrapper.split('\n').flatMap((line) => [line.trim(), stripTs(line).trim()]));
  const missing = dockerRows
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => stripTs(line).trim() && !known.has(line.trim()) && !known.has(stripTs(line).trim()))
    .map(({ line, index }) => ({
      length: Buffer.byteLength(line),
      sha256: shortHash(line),
      preview: line.length <= 240 ? clip(line) : null,
      eofFragment: dockerMeta.endsWithNewline === false && index === dockerRows.length - 1,
    }));
  return { status: missing.length ? 'differs' : 'matches', rows: dockerRows.length, missing };
};
const solverLogPrefix = /^\[\d{4}-\d\d-\d\dT[\d:.]+Z\] \[(?:INFO|ERROR|WARNING|WARN)\] /;
const normalizeSolverText = (text) => text.split('\n')
  .map((line) => line.replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z /, '').replace(solverLogPrefix, '').trimEnd())
  .join('\n');
const localFailureSignature = (text) => {
  const lines = normalizeSolverText(text).split('\n');
  const maxOutputTokens = 'Incomplete response returned, reason: max_output_tokens';
  const stoppedToolSession = /^❌ The AI session failed and (?:`--[\w-]+`|the automation) stopped \(tool_failure\)\.$/;
  let executionError = null;
  let outputLimitReported = false;
  let expectToolFailureDetail = false;
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (expectToolFailureDetail && line === `   ${maxOutputTokens}`) outputLimitReported = true;
    expectToolFailureDetail = false;
    if (line.startsWith('Error executing command: ') || line.startsWith('Error: ')) {
      const message = line.replace(/^Error(?: executing command)?: /, '');
      if (/^Repository has uncommitted changes after clone(?:$|:| \(.+?\)$)/.test(message)) executionError = 'checkout-dirty';
      else if (/^(?:Repository setup failed - empty repository|Empty repository auto-initialization failed|Empty repository detected - use --auto-init-repository to initialize)$/i.test(message)) executionError = 'repository-empty';
      continue;
    }
    if (line.startsWith('🩹 PR #') && line.endsWith('run end (AI session failed (tool_failure))')) {
      outputLimitReported = line.includes(`working session (${maxOutputTokens});`);
      continue;
    }
    if (!line.startsWith('❌ ')) continue;
    const verdict = line.slice(2);
    if (/^Error: solve exited with code \d+$/.test(verdict)) continue;
    if (/^Auto-restart limit reached after \d+ iterations? - the blocker was never resolved\.$/.test(verdict)) return 'auto-restart-limit';
    if (/^(?:Repository setup failed - empty repository|Empty repository auto-initialization failed|Empty repository detected - use --auto-init-repository to initialize)$/i.test(verdict)) return 'repository-empty';
    if (verdict === 'No progress between sessions') return 'no-progress';
    if (verdict === 'Same CI failure repeated') return 'same-ci-failure';
    if (verdict === 'Authentication error') return 'authentication';
    if (verdict === 'Permission check failed') return 'repository-permission';
    if (verdict === 'CODEX execution failed with ' + maxOutputTokens) return 'codex-max-output-tokens';
    if (verdict.startsWith('CODEX execution failed with This content was flagged for possible cybersecurity risk.')) return 'tool-content-policy';
    if (verdict === 'AI session failed (tool_failure)') return outputLimitReported ? 'codex-max-output-tokens' : 'tool-failure';
    if (verdict === 'Error occurred' && executionError) return executionError;
    executionError = null;
    outputLimitReported = false;
    expectToolFailureDetail = stoppedToolSession.test(line);
  }
  return null;
};

// --- report-logic:end ---

const loadClassifier = async () => {
  try {
    const mod = await import(pathToFileURL(path.join(dir, 'src/task-failure-signature.lib.mjs')).href);
    return typeof mod.classifyTaskFailure === 'function' ? mod.classifyTaskFailure : null;
  } catch {
    return null;
  }
};

// Lines of the bot log about one task, without loading 20+ MB into memory.
const botLines = (ev) => {
  const patterns = [ev.uuid, ev.sessionName, ...(ev.containerNames || [])].filter(Boolean);
  const r = run('grep', ['-F', ...patterns.flatMap((p) => ['-e', p]), BOT_LOG]);
  // Telegram traffic (chat ids, message texts) stays out of the report.
  return r.out.split('\n').filter((l) => l && !l.startsWith('[telegram-send]'))
    .map((l) => l.replace(/\bchat[=:]\s*"?-?\d+/gi, 'chat=<redacted>')).slice(-25).map(clip);
};

// hive-mind's sanitizer keeps the AI tool account's e-mail and account id
// (Codex telemetry puts them on every line, hive-mind#2837).
const redactAccounts = (text) => text
  .replace(/\b(user\.email|user\.account_id|account_id|organization_id|workspace_id)=("[^"]*"|\S+)/g, '$1=<redacted>')
  .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)*\.[a-z]{2,}/gi, (m) => /@(users\.noreply\.github\.com|anthropic\.com)$/i.test(m) ? m : '<redacted-email>');

const signatureOf = (ev, log, f, window = null, classifier = null) => {
  if (ev.exitCode === 127 && /^\s*\/[\w-]+\s/.test(ev.command || '')) return 'alias-127';
  if (/no rollout found for thread id/i.test(log)) return 'codex-no-rollout';
  // The agent finished (result event), its CLI did not exit within the close
  // timeout, and the SIGTERM exit code turned the run into a failure.
  if (ev.reason === 'failed' && /Result event received/.test(log) && /Stream timeout/.test(log) && /failed with exit code 143/.test(log)) return 'stream-close-timeout';
  if (ev.reason === 'lost') return 'lost';
  // The host itself went down (its journal stops without a shutdown): every
  // task dies with exit 255/137, and dockerd restarts only as a consequence.
  if (ev.reason === 'killed' && f?.hostReboot) return f.hostReboot.clean ? 'host-reboot' : 'host-reset';
  if (ev.reason === 'killed' && f?.daemonRestartNear) return 'daemon-restart';
  // The Codex CLI itself was OOM-killed: one issue for all of them, not the
  // generic cgroup OOM (#3719: a huge rollout in the shared sessions directory).
  if ((ev.reason === 'killed' || ev.reason === 'failed') && argOf(ev.command, 'tool') === 'codex' && /Codex (exited|command failed) with exit code 137/.test(log) && (f?.container?.oomKilled || f?.containerOomLines?.length || /oom_kill=[1-9]|OOM killer has killed [1-9]|"oomKills":[1-9]/.test(log))) return 'codex-oom';
  if (ev.reason === 'killed' && (f?.containerOomLines?.length || (f?.container?.oomKilled && f?.container?.memoryLimit))) return 'cgroup-oom';
  if (ev.reason === 'killed' && f?.globalOom?.length) return 'host-oom';
  if (ev.reason === 'killed') return 'killed';
  if (ev.reason === 'recovery-failed') return 'recovery-failed';
  // The AI CLI was OOM-killed at the task's memory limit and solve then exited
  // 1: the same cause as a killed container (master-plan#2, stylist-svelte#6).
  // Docker resets State.OOMKilled when the container is started again for the
  // next attempt, so the cgroup's own counters in the log count too.
  if (ev.reason === 'failed' && f?.container?.memoryLimit && /exit code 137/.test(log) && (f?.container?.oomKilled || /oom_kill=[1-9]|OOM killer has killed [1-9]/.test(log))) return 'cgroup-oom';
  // Ordinary exit-1 failures need the terminal verdict, not just the wrapper's
  // reason. Use hive-mind's shared classifier when installed; the local
  // fallback keeps the reporter useful in older installs.
  if (ev.exitCode === 1 && !window?.ambiguous) {
    const memoryExhausted = !!(f?.container?.oomKilled || f?.containerOomLines?.length || f?.globalOom?.length);
    const attempt = { exitCode: ev.exitCode, command: ev.command, oomKilled: !!f?.container?.oomKilled, memoryExhausted };
    let shared = null;
    try {
      shared = typeof classifier === 'function' ? classifier(attempt, log) : null;
    } catch {}
    if (shared) return shared;
    const local = localFailureSignature(log);
    if (local) return local;
  }
  return ev.reason;
};
const KNOWN = {
  'alias-127': 2887,
  'codex-no-rollout': 2888,
  'codex-oom': 3719,
  'daemon-restart': 2892,
  'host-reset': 3533,
  'stream-close-timeout': 3015,
};
const TITLES = {
  'alias-127': 'Kill recovery ran a Telegram alias as the program (exit 127)',
  'codex-no-rollout': 'Codex task could not be resumed: no rollout found for thread id',
  'daemon-restart': 'Task containers killed by a Docker daemon restart',
  'host-reset': 'Task containers killed by a host hard reset (the journal stops without a shutdown)',
  'host-reboot': 'Task containers killed by a host reboot',
  'codex-oom': 'Codex CLI killed by the task memory limit (cgroup OOM)',
  'cgroup-oom': 'Task container killed by its memory limit (cgroup OOM)',
  'host-oom': 'Task container killed during a host out-of-memory event',
  killed: 'Task container killed (exit >= 128) without an OOM or daemon restart on record',
  'recovery-failed': 'Recovery run of a killed task failed',
  lost: 'Task lost: record says executing, but no container or watcher is left',
  'program-not-found': 'Task exited 127 (program not found)',
  'stream-close-timeout': 'Finished task reported as failed: the CLI was killed by the stream close timeout (exit 143)',
  'repository-empty': 'Task failed: repository setup found an empty repository',
  'checkout-dirty': 'Task failed: checkout left uncommitted changes',
  'auto-restart-limit': 'Task failed: auto-restart limit reached',
  'no-progress': 'Task failed: no progress between sessions',
  'same-ci-failure': 'Task failed: the same CI failure repeated',
  authentication: 'Task failed: authentication error',
  'repository-permission': 'Task failed: repository permission check failed',
  'codex-max-output-tokens': 'Codex stopped at the max output token limit',
  'tool-content-policy': 'Codex stopped by the content policy',
  'tool-failure': 'Task failed in the AI tool',
  failed: 'Task failed',
};

let executionsCache = null;
const allExecutions = () => {
  if (!executionsCache) {
    try {
      executionsCache = listJson(['--list', '--output-format', 'json']).executions || [];
    } catch {
      executionsCache = [];
    }
  }
  return executionsCache;
};

const analyze = async (ev) => {
  let status = null;
  try {
    status = listJson(['--status', ev.uuid, '--output-format', 'json']);
  } catch {}
  const f = facts[ev.key] || null;
  const attemptList = status ? attemptsOf(status) : [];
  const current = attemptList.find((a) => a.number === ev.attempt);
  const next = attemptList.find((a) => a.number === ev.attempt + 1);
  // An attempt's own logOffset is its start. Without it, attempt 2+ is
  // ambiguous: the file also contains the earlier attempts' output.
  const start = Number.isFinite(current?.logOffset) ? current.logOffset
    : Number.isFinite(ev.logOffset) ? ev.logOffset
    : ev.attempt === 1 ? 0 : null;
  const stop = Number.isFinite(next?.logOffset) && next.logOffset >= 0 ? next.logOffset : null;
  const tail = readWindow(ev.logPath, start, stop, 512 * 1024);
  if (next && !Number.isFinite(next.logOffset)) tail.ambiguous = true;
  const all = tail.text.split('\n');
  // Lines of the agent's JSON stream (tool output, thinking signatures) are
  // left out: they only match by accident.
  const recovery = all.filter((l) => !/^\s*[{}"\]]/.test(l) && !/[A-Za-z0-9+\/=]{120,}/.test(l) && /\[HIVE-MIND RECOVERY\]|\[Start Command Lifecycle\]|exit code|exited with|Killed|OOM|out of memory|ENOSPC|No space left|heap limit|SIGKILL|SIGTERM/i.test(l) && !/(exited with|exit) code 0\b/i.test(l)).slice(-25).map(clip);
  const memory = all.filter((l) => /\b(memory|RSS|MemAvailable|heap)\b/i.test(l) && /\d/.test(l)).slice(-8).map(clip);
  const footer = all.filter(Boolean).slice(-30).map(clip);
  const docker = compareDocker(tail.text, dockerLinesForAttempt(f, ev), tail, { endsWithNewline: f?.dockerLogsEndsWithNewline });
  const attempts = attemptList.map((a) => `${a.number}: ${a.status || '?'} exit ${a.exitCode ?? '?'}${a.exitReason ? ' (' + a.exitReason + ')' : ''} ${a.sessionName || ''} ${a.startedAt || ''} → ${a.finishedAt || ''}`);
  const later = attemptList.filter((a) => a.number > ev.attempt);
  // Actual attempt windows, not "started after this one": a sequential retry
  // is not concurrent, and a run already in progress when this attempt started
  // is. Boundary-touching intervals do not overlap.
  const selectedWindow = attemptWindow({ startedAt: ev.startedAt, finishedAt: ev.finishedAt, status: ev.status });
  const otherAttempts = selectedWindow && ev.url ? allExecutions()
    .filter((e) => e.uuid !== ev.uuid && solveUrl(e.command) === ev.url)
    .flatMap((e) => attemptsOf(e).map((a) => ({ e, a, window: attemptWindow(a) }))) : [];
  const concurrent = otherAttempts.filter(({ window }) => overlaps(selectedWindow, window));
  const recovered = recoveryOutcome(ev, later, otherAttempts);
  const duplicates = concurrent.map(({ e, a, window }) => `\`${e.uuid}\` attempt ${a.number} ${new Date(window.start).toISOString()} → ${new Date(window.end).toISOString()}, exit ${a.exitCode ?? '?'}`);
  const classifier = await loadClassifier();
  return { status, f, tail, window: tail, docker, recovery, memory, footer, attempts, recovered: recovered + (duplicates.length ? '; **another execution of the same task overlapped this attempt: ' + duplicates.join('; ') + '**' : ''), log: tail.text, signature: signatureOf(ev, tail.text, f, tail, classifier) };
};

const section = (ev, a, links) => {
  const c = a.f?.container;
  const repos = a.f?.work?.repos || [];
  const work = repos.length
    ? repos.map((r) => `- \`${r.dir}\` on \`${r.branch || '?'}\`: ${r.dirtyFiles} uncommitted file(s), ${r.unpushedCommits ?? '?'} unpushed commit(s)${r.submoduleDirtyFiles || r.submoduleUnpushedCommits ? `; **in submodules: ${r.submoduleDirtyFiles} uncommitted file(s), ${r.submoduleUnpushedCommits} commit(s) on no remote**` : ''}, last commit ${r.lastCommit || '?'}`).join('\n')
    : '- ' + (a.f?.work?.error || 'no solver work dir found') + ' (checked via ' + (a.f?.work?.via || 'none') + ')';
  const w = a.window || a.tail || {};
  const interval = w.ambiguous
    ? 'start offset unavailable; the excerpt may contain an earlier attempt'
    : `${w.start ?? '?'}–${w.stop ?? '?'} bytes${w.clipped ? `; clipped at ${w.bytes} bytes of ${w.total}` : ''}`;
  const docker = a.docker || { status: 'no-docker-log', rows: 0, missing: [] };
  const dockerText = docker.status === 'matches'
    ? `matches the wrapper (${docker.rows} rows)`
    : docker.status === 'differs'
      ? `**${docker.missing.length} unmatched row(s)** of ${docker.rows}; see digests below`
      : docker.status === 'inconclusive'
        ? `comparison inconclusive: ${docker.reason}`
        : docker.reason || 'unavailable';
  const evidence = links.evidence ? `[bundle](${links.evidence})` : 'not uploaded';
  const dockerStream = links.dockerStream ? `[Docker stream](${links.dockerStream})` : 'not uploaded';
  const inventory = (a.evidence?.files || []).map((f) => `- \`${f.name}\`: ${f.bytes} bytes, sha256 \`${f.sha256}\`${f.source ? ` (from ${f.source})` : ''}`);
  const missingRows = docker.missing.map((m) => `- ${m.length} bytes, sha256 \`${m.sha256}\`${m.preview ? `: \`${m.preview}\`` : ''}${m.eofFragment ? ' (EOF fragment)' : ''}`);
  return [
    `### ${ev.url || ev.sessionName} — attempt ${ev.attempt}`,
    '',
    '| | |',
    '|---|---|',
    `| Execution | \`${ev.uuid}\` (attempt ${ev.attempt}, now \`${a.status?.status || ev.status}\`) |`,
    `| Container | \`${ev.sessionName}\`${c ? ' — ' + c.status + ', exit ' + c.exitCode + ', OOMKilled ' + c.oomKilled : ' — removed'} |`,
    `| Exit | ${ev.exitCode ?? '?'}${ev.exitReason ? ' (' + ev.exitReason + ')' : ''}; detected as **${ev.reason}**, signature **${a.signature}** |`,
    `| Ran | ${ev.startedAt || '?'} → ${ev.finishedAt || '?'} |`,
    `| Memory limit | ${c ? (c.memoryLimit ? gb(c.memoryLimit) : 'none') : 'unknown (container removed)'} |`,
    ...(a.f?.hostReboot ? [`| Host | ${a.f.hostReboot.clean ? 'rebooted' : '**hard reset**: the journal stops'} at ${a.f.hostReboot.lastEntryAt}${a.f.hostReboot.clean ? '' : ' with no shutdown'}; next boot ${a.f.hostReboot.nextBootAt} |`] : []),
    `| Writable layer | ${a.f?.layer || '?'} |`,
    `| Auto-recovered | ${a.recovered} |`,
    `| Wrapper log | ${w.size === null ? 'missing' : (w.size / 2 ** 20).toFixed(1) + ' MiB total'}; attempt ${interval}${links.log ? ' — [uploaded](' + links.log + ')' : ''} |`,
    `| Docker stream | ${dockerText} |`,
    `| Evidence | ${evidence} · ${dockerStream}${links.manifest ? ' · [manifest](' + links.manifest + ')' : ''} |`,
    '',
    '**Work left in the container**',
    '',
    work,
    '',
    '<details><summary>Attempts, recovery and lifecycle lines</summary>',
    '',
    fence(a.attempts),
    fence(a.recovery),
    '',
    '</details>',
    '',
    '<details><summary>Kernel and Docker daemon journal around the exit</summary>',
    '',
    fence([...(a.f?.kernel || []), ...(a.f?.daemon || [])].map(clip)),
    '',
    '</details>',
    '',
    '<details><summary>Memory lines and the end of the log</summary>',
    '',
    fence(a.memory),
    fence(a.footer),
    '',
    '</details>',
    '',
    '<details><summary>Evidence inventory and Docker tail comparison</summary>',
    '',
    inventory.length ? inventory.join('\n') : '- no evidence files were collected',
    '',
    missingRows.length ? 'Unmatched Docker rows (payload omitted; lengths and digests are enough to find them in the uploaded stream):\n\n' + missingRows.join('\n') : '',
    '',
    '</details>',
    '',
    '<details><summary>Bot log lines for this task</summary>',
    '',
    fence(botLines(ev)),
    '',
    '</details>',
    '',
    `<!-- auto-fix-key: ${ev.key} -->`,
  ].join('\n');
};

const gh = (...args) => run('gh', args);
// Every issue auto-fix files or comments on is a bug: type Bug and label bug.
const markBug = (number) => {
  gh('issue', 'edit', String(number), '-R', PARAMS.repo, '--add-label', 'bug');
  gh('api', '-X', 'PATCH', `repos/${PARAMS.repo}/issues/${number}`, '-f', 'type=Bug');
};
const ghJson = (...args) => {
  const r = gh(...args);
  if (r.code !== 0) throw new Error('gh ' + args.slice(0, 2).join(' ') + ': ' + (r.err || r.out).split('\n')[0]);
  return JSON.parse(r.out || 'null');
};
// Already on GitHub: search issue bodies and comments for the execution UUID,
// then look for the exact attempt key in what was found. A bare UUID counts
// only in an auto-fix report written before keys existed: a hand-written
// issue that mentions the task (#3214 did) may be about another problem.
const reportedOnGitHub = (ev) => {
  const found = ghJson('api', '-X', 'GET', 'search/issues', '-f', `q=${ev.uuid} repo:${PARAMS.repo} in:body,comments`, '-q', '[.items[].number]');
  for (const number of found || []) {
    const issue = ghJson('issue', 'view', String(number), '-R', PARAMS.repo, '--json', 'body,comments,url');
    const texts = [issue.body, ...(issue.comments || []).map((c) => c.body)];
    const legacy = (t) => ev.attempt === 1 && t.includes(ev.uuid) && t.includes('auto-fix found') && !t.includes('auto-fix-key:');
    if (texts.some((t) => t && (t.includes('auto-fix-key: ' + ev.key) || legacy(t)))) return issue.url;
  }
  // A report written by hand (or in another repository of the same owner,
  // e.g. link-assistant/formal-ai) that names the execution or its container.
  const ids = [ev.uuid, ev.sessionName].filter((id) => /^[0-9a-f]{8}-/.test(id || '')).map((id) => id.slice(0, 8));
  if (!ids.length) return null;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2100); // search API: 30 requests a minute
  const owner = PARAMS.repo.split('/')[0];
  const mentions = ghJson('api', '-X', 'GET', 'search/issues', '-f', `q=${[...new Set(ids)].join(' OR ')} org:${owner} in:body,comments`, '-q', '[.items[] | {repo: (.repository_url | split("/") | .[-2:] | join("/")), number}]');
  for (const { repo, number } of mentions || []) {
    const issue = ghJson('issue', 'view', String(number), '-R', repo, '--json', 'body,comments,url');
    const texts = [issue.body, ...(issue.comments || []).map((c) => c.body)];
    if (texts.some((t) => t && !t.includes('auto-fix-key:') && ids.some((id) => t.includes(id)))) return issue.url;
  }
  return null;
};

const results = [];
const errors = [];
const uploadedLogs = new Map();
const upload = async (file, description, uuid = null) => {
  if (PARAMS.dry || PARAMS.uploadLogs === false || !file || !fs.existsSync(file)) return null;
  if (uuid && startUploadSanitizes && !PARAMS.publicLogs) {
    // One log holds every attempt of an execution: uploaded once.
    if (!uploadedLogs.has(uuid)) uploadedLogs.set(uuid, uploadExecutionLog(uuid));
    const up = uploadedLogs.get(uuid);
    if (up.url) return up.url;
    errors.push(`$ --upload-log ${uuid}: ${up.error}; used hive-mind's uploader`);
  }
  const result = await uploadLogWithGhUploadLog({ logFile: file, isPublic: !!PARAMS.publicLogs, description });
  return result?.success ? result.url : null;
};

const evidenceKey = (ev) => String(ev.key).replace(/[^\w.-]+/g, '_');
const readTextFile = (file, maxBytes = Infinity) => {
  try {
    const fd = fs.openSync(file, 'r');
    const { size } = fs.fstatSync(fd);
    const length = Math.min(size, maxBytes);
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, 0);
    fs.closeSync(fd);
    return buffer.toString('utf8');
  } catch {
    return null;
  }
};
const botEvidenceLines = (ev) => {
  const patterns = [ev.uuid, ev.sessionName, ...(ev.containerNames || [])].filter(Boolean);
  if (!patterns.length) return [];
  const r = run('grep', ['-F', ...patterns.flatMap((p) => ['-e', p]), BOT_LOG]);
  const from = (Date.parse(ev.startedAt || '') || 0) - 60000;
  const to = (Date.parse(ev.finishedAt || '') || 0) + 300000;
  return r.out.split('\n').filter((line) => {
    if (!line || line.startsWith('[telegram-send]')) return false;
    const at = Date.parse(line.slice(0, 24));
    return !at || !from || (at >= from && at <= to);
  }).slice(-5000).map((line) => line.replace(/\bchat[=:]\s*"?-?\d+/gi, 'chat=<redacted>').slice(0, 2000));
};
const buildEvidenceBundle = (ev, a, dir, manifest) => {
  const parts = [
    '# auto-fix incident evidence',
    '',
    `- key: ${ev.key}`,
    `- execution: ${ev.uuid}`,
    `- attempt: ${ev.attempt}`,
    `- session: ${ev.sessionName || '?'}`,
    `- task: ${ev.url || '?'}`,
    `- generated: ${new Date().toISOString()}`,
    `- hive-mind: ${hiveVersion}`,
    `- start-command: ${startVersion}`,
    '',
    '## Start-command record',
    '',
    '```json',
    JSON.stringify(a.status, null, 2),
    '```',
    '',
    '## Manifest',
    '',
    '```json',
    JSON.stringify(manifest, null, 2),
    '```',
  ];
  for (const file of manifest.files || []) {
    if (file.name === 'docker.log') continue;
    const limit = 4 * 1024 * 1024;
    const text = readTextFile(path.join(dir, file.name), limit);
    if (text === null) continue;
    const clipped = file.bytes > limit;
    parts.push('', `## ${file.name}`, '', `bytes: ${file.bytes}; sha256: ${file.sha256}${clipped ? `; excerpt: first ${limit} bytes` : ''}`, '', '```', clipped ? text.slice(0, limit) : text, '```');
  }
  const bots = botEvidenceLines(ev);
  if (bots.length) parts.push('', '## Bot log lines', '', '```', bots.join('\n'), '```');
  return parts.join('\n');
};
const uploadEvidence = async (ev, a) => {
  const dir = PARAMS.evidenceDir ? path.join(PARAMS.evidenceDir, evidenceKey(ev)) : null;
  if (!dir || !fs.existsSync(dir)) return { files: [] };
  let manifest = null;
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  } catch {}
  const files = manifest?.files || [];
  const bundleDir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-evidence-'));
  const bundleFile = path.join(bundleDir, 'evidence.md');
  fs.writeFileSync(bundleFile, buildEvidenceBundle(ev, a, dir, manifest || { files }), { mode: 0o600 });
  const bundle = await upload(bundleFile, `${ev.url || ev.sessionName} execution ${ev.uuid} attempt ${ev.attempt} evidence bundle`, null);
  fs.rmSync(bundleDir, { recursive: true, force: true });
  const dockerFile = path.join(dir, 'docker.log');
  const dockerStream = fs.existsSync(dockerFile) ? await upload(dockerFile, `${ev.url || ev.sessionName} execution ${ev.uuid} attempt ${ev.attempt} Docker stream`, null) : null;
  return { bundle, dockerStream, manifest: bundle, files };
};
const analyzed = await Promise.all(PARAMS.events.map(async (ev) => ({ ev, a: await analyze(ev) })));
const groups = new Map();
for (const item of analyzed) {
  let url;
  try {
    url = reportedOnGitHub(item.ev);
  } catch (error) {
    errors.push(error.message);
    url = 'search-failed';
  }
  if (url === 'search-failed') continue; // retried on the next run
  if (url) {
    markReported(item.ev.key, { url, at: new Date().toISOString(), found: true });
    results.push({ signature: item.a.signature, keys: [item.ev.key], action: 'already reported', url });
    continue;
  }
  if (!groups.has(item.a.signature)) groups.set(item.a.signature, []);
  groups.get(item.a.signature).push(item);
}

// When the installed hive-mind was released (null when unknown, e.g. a test repo).
let installedAt;
const installedReleasedAt = () => {
  if (installedAt === undefined) {
    try {
      installedAt = Date.parse(ghJson('release', 'view', 'v' + hiveVersion, '-R', 'link-assistant/hive-mind', '--json', 'publishedAt').publishedAt) || null;
    } catch {
      installedAt = null;
    }
  }
  return installedAt;
};

let botLogUrl;
const botLog = botLogForUpload();
for (const [signature, items] of [...groups].slice(0, PARAMS.maxReports)) {
  try {
    let target = null;
    let related = null;
    if (KNOWN[signature]) {
      const known = ghJson('issue', 'view', String(KNOWN[signature]), '-R', PARAMS.repo, '--json', 'number,state,url,closedAt');
      const released = installedReleasedAt();
      if (known.state === 'OPEN') target = known.number;
      else if (released && Date.parse(known.closedAt) > released) {
        // Fixed upstream after the installed version: not a regression.
        const keys = items.map((i) => i.ev.key);
        if (!PARAMS.dry) for (const key of keys) markReported(key, { url: known.url, at: new Date().toISOString(), fixedUpstream: true });
        results.push({ signature, keys, action: `not reported: known issue closed after hive-mind ${hiveVersion} was released (the fix is not deployed yet)`, url: known.url });
        continue;
      } else related = known.url;
    }
    const title = '[auto-fix] ' + TITLES[signature];
    if (!target) {
      const open = ghJson('issue', 'list', '-R', PARAMS.repo, '--state', 'open', '--search', `in:title "${title}"`, '--json', 'number,title');
      target = (open || []).find((i) => i.title === title)?.number || null;
    }
    if (botLogUrl === undefined) botLogUrl = await upload(botLog.file, `hive-telegram-bot log${botLog.tail ? ' tail' : ''} (auto-fix report)`);
    const sections = [];
    for (const { ev, a } of items) {
      const log = await upload(ev.logPath, `${ev.url || ev.sessionName} execution ${ev.uuid} (auto-fix report)`, ev.uuid);
      const evidence = await uploadEvidence(ev, a);
      a.evidence = evidence;
      sections.push(section(ev, a, { log, evidence: evidence.bundle, dockerStream: evidence.dockerStream, manifest: evidence.manifest }));
    }
    const intro = [
      target ? `auto-fix found ${items.length} more task attempt(s) with this signature.` : `auto-fix found ${items.length} task attempt(s) that died with signature **${signature}**.`,
      related ? `\nThe known issue ${related} is closed; this may be a regression.` : '',
      '',
      `Versions: hive-mind ${hiveVersion}, start-command ${startVersion}. Host now: ${system.diskFree ? gb(system.diskFree) + ' disk free of ' + gb(system.diskTotal) : '?'}, ${system.memAvailable ? gb(system.memAvailable) + ' memory available of ' + gb(system.memTotal) : '?'}, load ${system.load || '?'}, Docker live-restore ${system.liveRestore || '?'}.`,
      botLogUrl ? `\nBot log: ${botLogUrl}` : '',
      '',
    ].join('\n');
    const body = redactAccounts(await sanitizeForPublication([intro, ...sections, target ? '' : '\n' + (PARAMS.footer || '')].join('\n\n')));
    const keys = items.map((i) => i.ev.key);
    if (PARAMS.dry) {
      fs.mkdirSync('/tmp/auto-fix', { recursive: true });
      const preview = '/tmp/auto-fix/report-preview-' + signature + '.md';
      fs.writeFileSync(preview, (target ? `<!-- comment on #${target} -->\n` : `<!-- new issue: ${title} -->\n`) + body);
      results.push({ signature, keys, action: target ? 'would comment on #' + target : 'would create issue', preview });
      continue;
    }
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'af-report-')), 'body.md');
    fs.writeFileSync(file, body, { mode: 0o600 });
    const r = target
      ? gh('issue', 'comment', String(target), '-R', PARAMS.repo, '--body-file', file)
      : gh('issue', 'create', '-R', PARAMS.repo, '--title', title, '--body-file', file);
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
    if (r.code !== 0) throw new Error((r.err || r.out).split('\n')[0]);
    const url = (/https:\/\/github\.com\/\S+/.exec(r.out) || [])[0] || null;
    const number = target || Number((/\/issues\/(\d+)/.exec(url || '') || [])[1]) || null;
    if (number) markBug(number);
    for (const key of keys) markReported(key, { url, at: new Date().toISOString() });
    results.push({ signature, keys, action: target ? 'commented on #' + target : 'created issue', url });
  } catch (error) {
    errors.push(signature + ': ' + (error.message || String(error)).split('\n')[0]);
  }
}
for (const [signature, items] of [...groups].slice(PARAMS.maxReports)) {
  results.push({ signature, keys: items.map((i) => i.ev.key), action: 'postponed (--max-reports)' });
}
if (!PARAMS.dry) {
  fs.mkdirSync(path.dirname(STATE), { recursive: true });
  fs.writeFileSync(STATE, JSON.stringify(state, null, 1));
}
console.log('AF_JSON:' + JSON.stringify({ results, errors }));
}
