// Container module: select stopped failed task containers for hive-cleanup while
// keeping every task that still has a running container. Prints one AF_JSON line.
import { execFileSync, execSync } from 'node:child_process';

const sh = (command) => execSync(command, { shell: '/bin/bash', encoding: 'utf8' }).trim();
const startCommand = sh("command -v '$'");
const listing = execFileSync(startCommand, ['--list', '--output-format', 'json'], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
const executions = JSON.parse(listing.slice(listing.indexOf('{'))).executions || [];
const ids = execFileSync('docker', ['ps', '-a', '-q'], { encoding: 'utf8' }).trim().split(/\s+/).filter(Boolean);
const containers = ids.length ? JSON.parse(execFileSync('docker', ['inspect', ...ids], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })) : [];
const processes = execFileSync('ps', ['-eo', 'args'], { encoding: 'utf8' }).split('\n');

const labelsOf = (c) => c.Config?.Labels || {};
const nameOf = (c) => String(c.Name || '').replace(/^\//, '');
const isTask = (c) => Boolean(labelsOf(c)['start-command.uuid']) || /^konard\/hive-mind-dind(?::|@)/.test(c.Config?.Image || '');
const rootOf = (c) => labelsOf(c)['start-command.root-session'] || labelsOf(c)['start-command.session'] || nameOf(c);
const uuidOf = (c) => labelsOf(c)['start-command.uuid'] || null;
const taskOf = (command) => {
  const text = command || '';
  const issue = /(https:\/\/github\.com\/[^\s'"]+\/(?:issues|pull)\/\d+)/.exec(text);
  if (issue) return issue[1].replace(/\/+$/, '');
  const repo = /(https:\/\/github\.com\/[^\s'"]+\/[^\s'"]+)/.exec(text);
  if (repo) return repo[1].replace(/\/+$/, '');
  const arg = /\bexec\s+'?(?:solve|fix)'?\s+'?([^\s'"]+)/.exec(text) || /^\s*(?:\/[\w-]+|solve|fix)\s+'?([^\s'"]+)/.exec(text);
  return arg ? arg[1] : null;
};

const byUuid = new Map();
const bySession = new Map();
for (const e of executions) {
  if (e.uuid) byUuid.set(e.uuid, e);
  for (const name of [e.options?.sessionName, ...(e.options?.sessionNameHistory || [])]) if (name) bySession.set(name, e);
}
const executionOf = (c) => byUuid.get(uuidOf(c)) || bySession.get(nameOf(c)) || null;
const familyOf = (c) => {
  const root = rootOf(c);
  return containers.filter((x) => isTask(x) && (rootOf(x) === root || nameOf(x) === root || nameOf(x).startsWith(root + '-resume-')));
};
const taskContainers = containers.filter(isTask);
const activeTasks = new Set();
for (const c of taskContainers.filter((x) => x.State?.Running)) {
  const task = taskOf(executionOf(c)?.command);
  if (task) activeTasks.add(task);
}

const targets = [];
const kept = [];
for (const c of taskContainers) {
  const state = c.State || {};
  if (state.Running || state.Status !== 'exited') continue;
  if (!Number.isInteger(state.ExitCode) || state.ExitCode === 0) continue;
  const name = nameOf(c);
  const execution = executionOf(c);
  const task = taskOf(execution?.command);
  const familyRunning = familyOf(c).some((x) => x.State?.Running);
  const uuid = execution?.uuid || uuidOf(c) || '';
  const resuming = processes.some((p) => (uuid && p.includes('--resume ' + uuid)) || p.startsWith('docker commit ' + rootOf(c) + ' '));
  if (familyRunning) { kept.push({ name, id: c.Id, reason: 'another container of this task is running' }); continue; }
  if (resuming) { kept.push({ name, id: c.Id, reason: 'the task is being resumed' }); continue; }
  if (!task) { kept.push({ name, id: c.Id, reason: 'the task target could not be determined' }); continue; }
  if (activeTasks.has(task)) { kept.push({ name, id: c.Id, reason: 'the task has an active container', task }); continue; }
  targets.push({
    name,
    id: c.Id,
    exitCode: state.ExitCode,
    finishedAt: state.FinishedAt,
    execution: execution?.uuid || null,
    task,
    image: c.Config?.Image || null,
    imageId: c.Image || null,
  });
}

console.log('AF_JSON:' + JSON.stringify({ targets, kept, activeTasks: [...activeTasks], containers: taskContainers.length }));
