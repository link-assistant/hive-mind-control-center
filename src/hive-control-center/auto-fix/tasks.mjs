// Runs on the host as root (host Node.js) via auto-fix.mjs, which prepends
// `const PARAMS = { seconds: 5, busyCores: 0.5, idleMinutes: 5, maxIdleMinutes: 30, kill: false };`
// (`only: <container>` limits kills to one container, for tests).
// Checks the running task containers for two kinds of stuck work found on
// 2026-10-20, from /proc and the task logs only (no docker exec, nothing
// written):
//
// 1. Playwright browsers that burn CPU while nobody uses them. A Claude task
//    with the Playwright MCP left a headless Chrome on an animated page: its
//    GPU process (software rendering, swiftshader) used ~2.7 cores for an
//    hour after the last browser call, until the MCP's own idle timer
//    (60 min for a headless browser it launched, @playwright/mcp 0.0.83)
//    closed it. On 2026-10-21 one burned 2-2.6 cores for 3.5 h, through
//    idle gaps of 31, 34, 49 and 59 min between bursts of calls, so the MCP's
//    timer never fired. Killing it costs the session little: the MCP's own
//    --idle-timeout help says "the next tool call relaunches it"; only the
//    open page is lost, which matters when the session comes back to it
//    without navigating. Evidence is Claude's own session transcript
//    (~/.claude/projects/<cwd>/<session>.jsonl in the container, appended per
//    message), never the start-command log: that one gets the stream-json in
//    late chunks (on 2026-10-21 it lacked browser calls 3 and 8 min old, while
//    the stderr debug lines kept its mtime fresh). In that session, every
//    return to the open page without navigating came after at most 1 work call
//    (Bash, Write, Edit, ...) and 11.6 min; the 31-59 min gaps had 2-86 work
//    calls and ended with resize or navigate. A browser of a live session is
//    killed only when:
//    - the transcript has the mcp__playwright__* call that launched it
//      (within minutes of its start) and no browser call pending (a tool_use
//      without its tool_result);
//    - the session moved on: at least `workCalls` (3) other tool calls (not
//      Read or ToolSearch, which belong to browser work) since the last
//      browser result and `idleMinutes` (5) passed, or `maxIdleMinutes` (30)
//      passed whatever happened;
//    - the browser tree uses at least `busyCores` now;
//    - its container has exactly one Playwright MCP, @playwright/mcp >= 0.0.83;
//    - no browser call reached the transcript while this check ran.
//    Two kinds are unusable whatever the log says, and are killed too:
//    - a detached browser: launched with --remote-debugging-pipe in a task
//      container, but its launcher is gone (reparented to the container's
//      init), so nothing holds the pipe that drives it;
//    - orphaned Chrome child processes (--type=renderer, gpu-process, ...)
//      whose browser process has exited: they only serve that process.
//    Each gets SIGTERM (SIGKILL after 10 s). Anything else (another AI tool,
//    an unknown log format, a browser outside a task container) is reported,
//    never killed.
//
// 2. Formal AI clients that wait or loop instead of failing. Restarting or
//    stopping the sidecar ends none of them (formal-ai#1328):
//    - Codex retries a dropped request after 5, 10, 20, 40, 60 s, then logs
//      "Reconnecting... waiting for network" once a minute, indefinitely;
//    - the agent CLI's own POST /session/<id>/message resets after ~256 s, and
//      Hive Mind takes that error event for a transient network failure and
//      resumes the session ("Retry N in M min (session preserved)") within a
//      12 h budget, repeating the same steps each time;
//    - `formal-ai serve` ignores SIGTERM (a `docker stop` ends with exit 137).
//    These are reported with the evidence; the task is left alone.
//
// Prints one AF_JSON line: { report: [lines], browsers, formalAi }.
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

const HZ = 100; // USER_HZ
const SECONDS = PARAMS.seconds || 5;
const BUSY = PARAMS.busyCores ?? 0.5;
const IDLE_MIN = PARAMS.idleMinutes ?? 5;
const MAX_IDLE_MIN = PARAMS.maxIdleMinutes ?? 30;
const WORK_CALLS = PARAMS.workCalls ?? 3;
const BROWSER_WORK = /^(Read|ToolSearch)$/; // reading a screenshot, loading the browser tools
const LAUNCH_SLACK_S = 300; // a browser starts within this long after the call that needs it
const MCP_MIN_VERSION = [0, 0, 83]; // relaunch after a closed browser checked in this version
const MAX_LOG = 256 * 1048576;

const run = (cmd, args, timeout = 20000) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout, maxBuffer: 64 * 1024 * 1024 });
  return r.status === 0 ? (r.stdout || '') : '';
};
const read = (file) => { try { return fs.readFileSync(file, 'utf8'); } catch { return null; } };
const redact = (text) => text
  .replace(/--configuration\b.*/s, '--configuration [redacted]')
  .replace(/\b(gh[pousr]_|github_pat_)[A-Za-z0-9_]+/g, '$1***')
  .replace(/\bsk-[A-Za-z0-9_-]{16,}/g, 'sk-***')
  .replace(/\b\d{6,}:[A-Za-z0-9_-]{30,}\b/g, '***:***')
  .replace(/((?:token|password|passwd|secret|api[_-]?key)[=: ]+)\S+/gi, '$1***');
const round = (n, d = 2) => Math.round(n * 10 ** d) / 10 ** d;
const dur = (s) => (s >= 3600 ? `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m` : `${Math.floor(s / 60)}m${String(Math.floor(s % 60)).padStart(2, '0')}s`);
const hhmm = (ms) => new Date(ms).toISOString().slice(11, 19) + 'Z';
const bootTime = Date.now() / 1000 - Number(read('/proc/uptime').split(' ')[0]);
const startMs = (ticks) => (bootTime + ticks / HZ) * 1000;
const report = [];
const say = (line) => report.push(line);

// ---- Containers, task URLs and their start-command logs ----
const containers = new Map(); // full id -> facts
const ids = run('docker', ['ps', '--no-trunc', '-q']).split('\n').filter(Boolean);
for (const line of (ids.length ? run('docker', ['inspect', '-f', '{{.Id}}\t{{.Name}}\t{{.State.Pid}}\t{{json .Config.Cmd}}', ...ids]) : '').split('\n').filter(Boolean)) {
  const [id, name, pid, cmdJson] = line.split('\t');
  let cmd = [];
  try { cmd = JSON.parse(cmdJson) || []; } catch {}
  const text = cmd.join(' ');
  const opt = (o) => new RegExp(`'--${o}' '([^']+)'`).exec(text)?.[1] || new RegExp(`--${o}\\s+(\\S+)`).exec(text)?.[1] || null;
  const url = /'solve' '([^']+)'/.exec(text)?.[1] || (cmd[0] === 'solve' ? cmd[1] : null) || /\bsolve\s+(https:\/\/\S+)/.exec(text)?.[1] || null;
  containers.set(id, { id, name: name.replace(/^\//, ''), initPid: Number(pid), url, tool: url ? opt('tool') || 'claude' : null, model: url ? opt('model') : null });
}
const byName = new Map([...containers.values()].map((c) => [c.name, c]));
const root = byName.get('hive-mind');
const logDir = root?.initPid ? `/proc/${root.initPid}/root/tmp/start-command/logs/isolation/docker` : null;
if (logDir) {
  let files = [];
  try { files = fs.readdirSync(logDir).filter((f) => f.endsWith('.log')); } catch {}
  for (const f of files) {
    let head = '';
    try { const fd = fs.openSync(`${logDir}/${f}`, 'r'); const b = Buffer.alloc(1500); head = b.toString('utf8', 0, fs.readSync(fd, b, 0, 1500, 0)); fs.closeSync(fd); } catch { continue; }
    const c = byName.get(/^Session: (\S+)/m.exec(head)?.[1]);
    if (c) { c.execution = /^Execution ID: (\S+)/m.exec(head)?.[1] || f.replace(/\.log$/, ''); c.log = `${logDir}/${f}`; }
  }
}
const label = (c) => `${c.name}${c.url ? ` (${c.url} --tool ${c.tool}${c.model ? ' --model ' + c.model : ''})` : ''}`;

// The task log: start-command copies the solver's output, where every
// stream-json object is pretty-printed with its braces alone on a line.
const logObjects = (file, from = 0) => {
  let text = '';
  let size = 0;
  try {
    size = fs.statSync(file).size;
    const start = Math.max(from, size - MAX_LOG);
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    text = buf.toString('utf8');
  } catch { return { size, objects: [], lines: [] }; }
  const lines = text.split('\n');
  const objects = [];
  let open = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] === '{') open = i;
    else if (lines[i] === '}' && open >= 0) {
      try { objects.push(JSON.parse(lines.slice(open, i + 1).join('\n'))); } catch {}
      open = -1;
    }
  }
  return { size, objects, lines };
};

// ---- Processes ----
const procs = new Map();
const scan = () => {
  const ticks = new Map();
  for (const name of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    const s = read(`/proc/${name}/stat`);
    if (!s) continue;
    const f = s.slice(s.lastIndexOf(')') + 2).split(' ');
    const pid = Number(name);
    ticks.set(pid, { t: Number(f[11]) + Number(f[12]), start: Number(f[19]) });
    if (procs.has(pid) && procs.get(pid).start === Number(f[19])) continue;
    const cmd = (read(`/proc/${name}/cmdline`) || '').split('\n')[0].replace(/\0/g, ' ').trim();
    const cid = /([0-9a-f]{64})/.exec(read(`/proc/${name}/cgroup`) || '')?.[1];
    procs.set(pid, { pid, comm: s.slice(s.indexOf('(') + 1, s.lastIndexOf(')')), state: f[0], ppid: Number(f[1]), start: Number(f[19]), cmd, container: cid ? containers.get(cid) : null });
  }
  return ticks;
};
const t0 = Date.now();
const before = scan();
const CHROME = /^(chrome|chromium|chromium-browse|headless_shell|chrome-headless)$/;
const MCP = /playwright-mcp|@playwright\/mcp|mcp-server-playwright/;
const live = [...procs.values()].filter((p) => p.state !== 'Z');
const kids = new Map();
for (const p of live) kids.set(p.ppid, [...(kids.get(p.ppid) || []), p]);
const tree = (p) => [p, ...(kids.get(p.pid) || []).flatMap(tree)];
const ancestors = (p) => { const out = []; for (let q = procs.get(p.ppid); q && out.length < 30; q = procs.get(q.ppid)) out.push(q); return out; };
const mains = live.filter((p) => CHROME.test(p.comm) && !/--type=/.test(p.cmd) && !CHROME.test(procs.get(p.ppid)?.comm || ''));
const inTree = new Set(mains.flatMap((m) => tree(m).map((p) => p.pid)));
const orphans = live.filter((p) => CHROME.test(p.comm) && !inTree.has(p.pid));
const zombies = new Map();
for (const p of procs.values()) if (p.state === 'Z' && p.container) zombies.set(p.container.name, (zombies.get(p.container.name) || 0) + 1);
const mcpsIn = (c) => live.filter((p) => p.container === c && MCP.test(p.cmd) && /(^|\/)node$/.test(p.cmd.split(' ')[0]));

await new Promise((resolve) => setTimeout(resolve, SECONDS * 1000));
const after = scan();
const seconds = (Date.now() - t0) / 1000;
const cores = (pids) => pids.reduce((sum, pid) => {
  const a = before.get(pid), b = after.get(pid);
  return a && b && a.start === b.start ? sum + (b.t - a.t) : sum;
}, 0) / HZ / seconds;
const lifetime = (pids) => pids.reduce((sum, pid) => sum + (after.get(pid)?.t || 0), 0) / HZ;

const mcpVersion = (mcp) => {
  const script = mcp.cmd.split(' ').find((a) => a.includes('/node_modules/'));
  if (!script) return null;
  const base = script.slice(0, script.lastIndexOf('/node_modules/') + '/node_modules/'.length);
  try {
    const pkg = JSON.parse(read(`/proc/${mcp.pid}/root${base}@playwright/mcp/package.json`));
    return pkg.name === '@playwright/mcp' ? pkg.version : null;
  } catch { return null; }
};
const atLeast = (v, min) => {
  const p = String(v).split(/[.-]/).slice(0, 3).map(Number);
  for (let i = 0; i < 3; i++) if (p[i] !== min[i]) return p[i] > min[i];
  return true;
};

// Claude's session transcript, written per message (unlike the start-command
// log): <config dir>/projects/<cwd, non-alphanumerics as '-'>/<session>.jsonl,
// plus its subagents' transcripts under <session>/, all read through the
// claude process's own root.
const transcriptsOf = (ai) => {
  const env = (read(`/proc/${ai.pid}/environ`) || '').split('\0');
  const get = (k) => env.find((e) => e.startsWith(`${k}=`))?.slice(k.length + 1);
  let cwd;
  try { cwd = fs.readlinkSync(`/proc/${ai.pid}/cwd`); } catch { return null; }
  const dir = `/proc/${ai.pid}/root${get('CLAUDE_CONFIG_DIR') || `${get('HOME') || '/root'}/.claude`}/projects/${cwd.replace(/[^a-zA-Z0-9]/g, '-')}`;
  const aiStart = startMs(ai.start);
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')).map((f) => ({ file: `${dir}/${f}`, mtime: fs.statSync(`${dir}/${f}`).mtimeMs })); } catch { return null; }
  const main = files.filter((f) => f.mtime >= aiStart).sort((x, y) => y.mtime - x.mtime)[0];
  if (!main) return null;
  const sub = [];
  const walk = (d, depth) => { try { for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (e.isDirectory() && depth < 2) walk(`${d}/${e.name}`, depth + 1); else if (e.name.endsWith('.jsonl')) sub.push(`${d}/${e.name}`); } } catch {} };
  walk(main.file.replace(/\.jsonl$/, ''), 0);
  return [main.file, ...sub];
};
const tailText = (file, from = 0) => {
  try {
    const size = fs.statSync(file).size;
    const start = Math.max(from, size - MAX_LOG);
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    return { size, text: buf.toString('utf8') };
  } catch { return { size: 0, text: '' }; }
};
// Browser calls, and other tool calls, from the transcripts' JSONL messages.
const claudeBrowserCalls = (files) => {
  const calls = new Map();
  const others = [];
  let known = false, lastEvent = null;
  const sizes = {};
  for (const file of files) {
    const { size, text } = tailText(file);
    sizes[file] = size;
    for (const line of text.split('\n')) {
      if (!line.includes('"timestamp"')) continue;
      let o;
      try { o = JSON.parse(line); } catch { continue; }
      if (!['assistant', 'user'].includes(o.type) || typeof o.timestamp !== 'string') continue;
      known = true;
      const at = Date.parse(o.timestamp);
      if (!lastEvent || at > lastEvent) lastEvent = at;
      for (const c of Array.isArray(o.message?.content) ? o.message.content : []) {
        if (c?.type === 'tool_use' && /^mcp__playwright__/.test(c.name || '')) calls.set(c.id, { id: c.id, name: c.name.replace('mcp__playwright__', ''), at, endedAt: null });
        else if (c?.type === 'tool_use') others.push({ name: c.name, at });
        if (c?.type === 'tool_result' && calls.has(c.tool_use_id)) calls.get(c.tool_use_id).endedAt = at;
      }
    }
  }
  return { known, lastEvent, calls: [...calls.values()].sort((x, y) => x.at - y.at), others, sizes };
};

// ---- 1. Playwright browsers ----
const browsers = [];
for (const main of mains) {
  const members = tree(main);
  const pids = members.map((p) => p.pid);
  const c = main.container;
  const started = startMs(main.start);
  const b = {
    pid: main.pid, container: c?.name || null, task: c?.url || null, tool: c?.tool || null,
    processes: members.length, cores: round(cores(pids)), startedAt: new Date(started).toISOString(),
    ageMinutes: Math.round((Date.now() - started) / 60000), cpuMinutes: Math.round(lifetime(pids) / 60),
    headless: /--headless/.test(main.cmd), swiftshader: members.some((p) => /swiftshader/.test(p.cmd)),
    busiest: members.map((p) => ({ type: /--type=(\S+)/.exec(p.cmd)?.[1] || 'browser', cores: round(cores([p.pid])) })).sort((x, y) => y.cores - x.cores)[0],
  };
  const mcp = ancestors(main).find((p) => MCP.test(p.cmd));
  const ai = ancestors(main).find((p) => /^(claude|codex|agent|opencode|gemini|qwen)\b/.test(p.comm) || /\b(claude|codex)(\s|$)/.test(p.cmd.split(' ')[0] || ''));
  b.owner = [mcp ? `Playwright MCP (pid ${mcp.pid})` : null, ai ? `${ai.comm} (pid ${ai.pid})` : null].filter(Boolean).join(' < ') || redact(procs.get(main.ppid)?.cmd || '?').slice(0, 80);
  const blockers = [];
  if (!c?.url) blockers.push('not in a task container');
  // Detached: Playwright drives its browser over fds 3/4 (--remote-debugging-pipe);
  // reparented to the container's init means the launcher, and the pipe, are gone.
  b.detached = Boolean(c?.url && !mcp && /--remote-debugging-pipe/.test(main.cmd) && main.ppid === c.initPid);
  if (b.detached) {
    b.stuck = true;
    if (PARAMS.only && b.container !== PARAMS.only) blockers.push(`outside the container under test (${PARAMS.only})`);
    b.killable = blockers.length === 0;
    b.blockers = blockers;
    b.owner = 'none: its launcher exited (reparented to the container init), so nothing can drive it';
    browsers.push(b);
    continue;
  }
  if (!mcp) blockers.push('not started by a Playwright MCP');
  const version = mcp ? mcpVersion(mcp) : null;
  b.mcpVersion = version;
  if (mcp && !version) blockers.push('@playwright/mcp version unknown');
  else if (version && !atLeast(version, MCP_MIN_VERSION)) blockers.push(`@playwright/mcp ${version} is older than ${MCP_MIN_VERSION.join('.')}, whose relaunch after a closed browser was checked`);
  const mcps = c ? mcpsIn(c) : [];
  if (c && mcps.length !== 1) blockers.push(`${mcps.length} Playwright MCPs in the container`);
  if (c?.url && c.tool !== 'claude') blockers.push(`the session of --tool ${c.tool} has no transcript format this check knows`);
  const transcripts = c?.url && c.tool === 'claude' && ai ? transcriptsOf(ai) : null;
  if (c?.url && c.tool === 'claude' && !transcripts) blockers.push('Claude session transcript not found');
  let idleMs = null;
  let movedOn = false;
  if (transcripts) {
    const { known, lastEvent, calls, others, sizes } = claudeBrowserCalls(transcripts);
    b.transcript = transcripts[0].replace(/^\/proc\/\d+\/root/, '');
    b.transcriptSizes = sizes;
    if (!known) blockers.push('no Claude messages in the transcript');
    const recent = calls.filter((x) => x.at >= started - LAUNCH_SLACK_S * 1000);
    const launch = recent.find((x) => x.at <= started + 60000);
    const pending = recent.filter((x) => !x.endedAt);
    const last = calls.at(-1);
    if (known && !launch) blockers.push(`no browser call in the transcript launched it (started ${hhmm(started)})`);
    if (pending.length) blockers.push(`browser call in progress: ${pending.at(-1).name} since ${hhmm(pending.at(-1).at)}`);
    if (last) {
      const idleSince = Math.max(last.at, last.endedAt || 0);
      idleMs = Date.now() - idleSince;
      const work = others.filter((x) => x.at > idleSince && !BROWSER_WORK.test(x.name));
      const counts = {};
      for (const x of work) counts[x.name] = (counts[x.name] || 0) + 1;
      b.workCallsSince = work.length;
      b.workSince = Object.entries(counts).map(([n, k]) => `${n} ${k}`).join(', ');
      movedOn = (work.length >= WORK_CALLS && idleMs >= IDLE_MIN * 60000) || idleMs >= MAX_IDLE_MIN * 60000;
      b.lastCall = { tool: last.name, at: new Date(last.at).toISOString(), endedAt: last.endedAt ? new Date(last.endedAt).toISOString() : null };
      b.idleMinutes = Math.round(idleMs / 60000);
      b.idleFor = dur(idleMs / 1000);
      if (b.headless && launch) b.mcpClosesAt = new Date(idleSince + 3600000).toISOString(); // its own idle timer, headless browsers it launched
    }
    b.lastTranscriptEvent = lastEvent ? new Date(lastEvent).toISOString() : null;
    b.browserCalls = calls.length;
  }
  if (idleMs !== null && !movedOn) {
    blockers.push(idleMs < IDLE_MIN * 60000
      ? `last browser call ${dur(idleMs / 1000)} ago, less than ${IDLE_MIN} min`
      : `the session has not moved on: ${b.workCallsSince} other tool call(s) since the last browser call (needs ${WORK_CALLS}, or ${MAX_IDLE_MIN} min idle)`);
  }
  if (b.cores < BUSY) blockers.push(`uses ${b.cores} cores, less than ${BUSY}`);
  if (PARAMS.only && b.container !== PARAMS.only) blockers.push(`outside the container under test (${PARAMS.only})`);
  b.stuck = b.cores >= BUSY && movedOn;
  b.killable = blockers.length === 0;
  b.blockers = blockers;
  browsers.push(b);
}

// Kill only confirmed ones, after a last look at the log and the process.
const alive = (pid, start) => { const s = read(`/proc/${pid}/stat`); if (!s) return false; const f = s.slice(s.lastIndexOf(')') + 2).split(' '); return f[0] !== 'Z' && Number(f[19]) === start; };
const waitGone = async (ps, ms) => { for (let t = 0; t < ms; t += 250) { if (!ps.some((p) => alive(p.pid, p.start))) return true; await new Promise((r) => setTimeout(r, 250)); } return !ps.some((p) => alive(p.pid, p.start)); };
// SIGTERM, then SIGKILL after 10 s, only to processes still the ones that were checked.
const terminate = async (ps) => {
  const targets = ps.filter((p) => alive(p.pid, p.start));
  if (!targets.length) return 'exited by itself';
  for (const p of targets) { try { process.kill(p.pid, 'SIGTERM'); } catch {} }
  let gone = await waitGone(targets, 10000);
  let how = 'SIGTERM';
  if (!gone) { for (const p of targets) { try { if (alive(p.pid, p.start)) process.kill(p.pid, 'SIGKILL'); } catch {} } gone = await waitGone(targets, 5000); how = 'SIGTERM, then SIGKILL after 10 s'; }
  return gone ? `killed (${how})` : `still running after ${how}`;
};
for (const b of browsers.filter((x) => x.killable)) {
  const main = procs.get(b.pid);
  const c = main.container;
  if (!b.detached) {
    const fresh = Object.entries(b.transcriptSizes).some(([file, size]) => tailText(file, size).text.includes('mcp__playwright__'));
    if (fresh) { b.killable = false; b.blockers.push('a browser call reached the transcript during the check'); continue; }
  }
  if (!PARAMS.kill) { b.action = 'would kill (dry run or --no-kill-stuck-browsers)'; continue; }
  b.action = await terminate([main]);
  // Its child processes shut down with it; give them a moment before counting.
  const children = tree(main).filter((p) => p.pid !== main.pid);
  if (b.action.startsWith('killed')) await waitGone(children, 5000);
  const left = children.filter((p) => alive(p.pid, p.start));
  if (b.action.startsWith('killed') && left.length) b.action += `, ${left.length} child process(es) still running 5 s later`;
}

for (const b of browsers) {
  const what = `Browser pid ${b.pid} in ${b.container || 'host'}${b.task ? ` (${b.task})` : ''}: ${b.cores} cores now (busiest: ${b.busiest.type} ${b.busiest.cores}), ${b.cpuMinutes} CPU min in ${b.ageMinutes} min, ${b.processes} processes, ${b.headless ? 'headless' : 'headed'}${b.swiftshader ? ', software rendering' : ''}; owner ${b.owner}${b.mcpVersion ? `, @playwright/mcp ${b.mcpVersion}` : ''}`;
  const log = b.lastCall ? `last browser call ${b.lastCall.tool} at ${b.lastCall.at.slice(11, 19)}Z, idle for ${b.idleFor} (${b.browserCalls} in the transcript), ${b.workCallsSince} other tool call(s) since${b.workSince ? ` (${b.workSince})` : ''}${b.mcpClosesAt ? `; the MCP closes it by itself at ${b.mcpClosesAt.slice(11, 19)}Z if still unused` : ''}` : 'no browser call found in the transcript';
  if (b.detached) say(`${b.action?.startsWith('killed') ? 'KILLED' : 'STUCK'}: detached ${what}; ${b.action || `not killed: ${b.blockers.join('; ')}`}`);
  else if (b.action) say(`${b.action.startsWith('killed') ? 'KILLED' : 'STUCK'}: ${what}; ${log}; ${b.action}${b.action.startsWith('killed') ? ': the Playwright MCP launches a new browser on its next call (the open page is lost)' : ''}`);
  else if (b.stuck) say(`STUCK (not killed: ${b.blockers.join('; ')}): ${what}; ${log}`);
  else say(`${what}; ${log}${b.cores >= BUSY ? ` (not killed: ${b.blockers.join('; ')})` : ''}`);
}
const orphanGroups = new Map();
for (const p of orphans) {
  const key = `${p.container?.name || 'host'}|${/--user-data-dir=(\S+)/.exec(p.cmd)?.[1] || ''}`;
  orphanGroups.set(key, [...(orphanGroups.get(key) || []), p]);
}
const orphanList = [...orphanGroups].map(([key, ps]) => ({ container: key.split('|')[0], profile: key.split('|')[1] || null, processes: ps.length, cores: round(cores(ps.map((p) => p.pid))), pids: ps.map((p) => p.pid), ps }));
for (const o of orphanList) {
  // Child processes (--type=...) only serve their browser process; with it gone
  // and no live browser on the same profile, nothing can use them.
  const children = o.ps.filter((p) => /--type=/.test(p.cmd));
  const sameProfile = o.profile && mains.some((m) => m.cmd.includes(`--user-data-dir=${o.profile}`) && alive(m.pid, m.start));
  let action;
  if (!o.ps[0].container?.url) action = 'reported only: not in a task container';
  else if (PARAMS.only && o.container !== PARAMS.only) action = `reported only: outside the container under test (${PARAMS.only})`;
  else if (sameProfile) action = 'reported only: a browser on the same profile is running';
  else if (children.length !== o.ps.length) action = 'reported only: not all are Chrome child processes';
  else action = PARAMS.kill ? await terminate(children) : 'would kill (dry run or --no-kill-stuck-browsers)';
  o.action = action;
  say(`${action.startsWith('killed') ? 'KILLED' : 'Orphaned'} browser processes in ${o.container}: ${o.processes} (pids ${o.pids.slice(0, 6).join(', ')}${o.pids.length > 6 ? ', ...' : ''}), ${o.cores} cores, their browser process is gone; ${action}`);
  delete o.ps;
}
for (const [name, n] of zombies) if (n >= 20) say(`${name}: ${n} zombie processes (finished, never reaped: the container's PID 1 does not reap orphans, e.g. no --init); harmless until the PID limit`);
if (!browsers.length && !orphanList.length) say('No browsers running');

// ---- 2. Formal AI clients ----
const formalAi = { sidecars: [], clients: [] };
for (const line of run('docker', ['ps', '-a', '--filter', 'name=formal-ai', '--format', '{{.Names}}\t{{.Command}}']).split('\n').filter((l) => !/solve/.test(l)).map((l) => l.split('\t')[0]).join('\n').split('\n').filter(Boolean)) {
  const [state, exitCode, finishedAt, restart] = run('docker', ['inspect', '-f', '{{.State.Status}}\t{{.State.ExitCode}}\t{{.State.FinishedAt}}\t{{.HostConfig.RestartPolicy.Name}}', line]).trim().split('\t');
  formalAi.sidecars.push({ name: line, state, exitCode: Number(exitCode), finishedAt, restart });
}
for (const s of formalAi.sidecars) {
  say(`Formal AI sidecar ${s.name}: ${s.state}${s.state !== 'running' ? ` since ${s.finishedAt.replace(/\.\d+Z$/, 'Z')}, exit ${s.exitCode}${s.exitCode === 137 ? ' (killed after the stop timeout: formal-ai serve ignores SIGTERM)' : ''}` : ''}, restart policy ${s.restart || 'no'}`);
}
const sidecarUp = formalAi.sidecars.some((s) => s.state === 'running');
for (const c of containers.values()) {
  if (!c.url || !/formal-ai/.test(`${c.model} ${c.name}`)) continue;
  const client = { container: c.name, task: c.url, tool: c.tool, execution: c.execution || null };
  formalAi.clients.push(client);
  if (!c.log) { say(`Formal AI client ${label(c)}: task log not found`); continue; }
  const { objects, lines } = logObjects(c.log);
  const retries = lines.filter((l) => /Retry \d+ in .+\(session preserved\)/.test(l));
  const lastRetry = retries.at(-1);
  if (lastRetry) {
    const m = /([A-Z][^.⚠]*?) detected\. Retry (\d+) in (.+?) \(session preserved\)(?: \(budget ([^)]+)\))?/.exec(lastRetry);
    client.hiveMindRetries = retries.length;
    client.lastRetry = m ? { reason: m[1], attempt: Number(m[2]), in: m[3], budget: m[4] || null } : lastRetry.trim().slice(0, 160);
  }
  const resets = objects.filter((o) => o.message === 'HTTP request failed' && /\/session\/[^/]+\/message$/.test(o.url || '') && o.durationMs >= 250000);
  if (resets.length) client.agentResets = { count: resets.length, last: resets.at(-1).timestamp, durationsS: resets.map((o) => Math.round(o.durationMs / 1000)) };
  const waits = lines.filter((l) => l.includes('Reconnecting... waiting for network'));
  const codexRetries = lines.filter((l) => l.includes('responses_retry') && l.includes('stream connection failed'));
  const lastStamp = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)[\d.]*Z\s/.exec([...lines].reverse().find((l) => /^\d{4}-\d\d-\d\dT[\d:.]+Z\s/.test(l)) || '')?.[1];
  if (waits.length || codexRetries.length) client.codexWaiting = { reconnecting: waits.length, retries: codexRetries.length, lastLogTime: lastStamp || null };
  const parts = [];
  if (client.lastRetry) parts.push(typeof client.lastRetry === 'string' ? client.lastRetry : `Hive Mind resumed it ${client.hiveMindRetries} time(s), next: retry ${client.lastRetry.attempt} in ${client.lastRetry.in} after "${client.lastRetry.reason}"${client.lastRetry.budget ? ` (budget ${client.lastRetry.budget})` : ''}`);
  if (client.agentResets) parts.push(`the agent's own POST /session/<id>/message reset ${client.agentResets.count} time(s) after ${client.agentResets.durationsS.join(', ')} s (last ${client.agentResets.last}); Hive Mind takes it for a network failure`);
  if (client.codexWaiting) parts.push(`Codex waits for the model server: ${client.codexWaiting.retries} retries, ${client.codexWaiting.reconnecting} "Reconnecting... waiting for network" (last timestamped log line ${client.codexWaiting.lastLogTime ? client.codexWaiting.lastLogTime + 'Z' : '?'}); it does not fail the turn by itself`);
  say(`Formal AI client ${label(c)}: ${parts.join('; ') || 'no retry or wait pattern in its log'}`);
  if (!sidecarUp && parts.length) report[report.length - 1] += '. The sidecar is not running, so this task cannot progress: restarting or stopping the sidecar does not end it, only stopping its container does (left to the operator)';
  if (sidecarUp && client.agentResets && client.lastRetry) report[report.length - 1] += `. Each resume repeats the same steps (formal-ai#1328): ./auto-fix.mjs --collect ${c.execution || c.name} shows whether it loops`;
}

console.log('AF_JSON:' + JSON.stringify({ report, browsers, orphans: orphanList, zombies: Object.fromEntries(zombies), formalAi, sampleSeconds: round(seconds, 1) }));
