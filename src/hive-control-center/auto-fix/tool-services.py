"""Stop recognized idle Codex/Claude helpers, never task or foreground processes."""
import fcntl
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time


def classify(args, comm):
    if not args:
        return None, None
    exe = Path(args[0]).name
    offset = 1
    if exe in ('node', 'bun', 'nodejs') and len(args) > 1:
        entry = args[1]
        if entry.endswith('/codex.js'):
            tool = 'codex'
        elif '@anthropic-ai/claude-code/' in entry:
            tool = 'claude'
        else:
            return None, None
        offset = 2
    elif exe in ('codex', 'claude'):
        tool = exe
    elif comm in ('codex', 'claude'):
        tool = comm
    else:
        return None, None
    words = args[offset:]
    if tool == 'codex' and words[:3] == ['app-server', 'daemon', 'pid-update-loop']:
        return tool, 'updater'
    if tool == 'codex' and words[:1] == ['app-server'] and '--managed-daemon' in words:
        return tool, 'managed-daemon'
    if tool == 'claude' and any(x in words for x in ('--claude-in-chrome-mcp', '--chrome-native-host')):
        return tool, 'browser-helper'
    # Unknown modes, exec, login, remote-control, MCP serving and interactive
    # sessions remain foreground work. A process name alone never authorizes a kill.
    return tool, 'foreground'


def command_tool(command):
    import re
    text = str(command).replace("'", '').replace('"', '')
    m = re.search(r'--tool(?:=|\s+)(codex|claude)\b', text)
    if m:
        return m.group(1)
    for tool in ('codex', 'claude'):
        if text.lstrip().startswith('/' + tool + ' '):
            return tool
    if 'solve' in text and 'https://github.com/' in text and '--tool' not in text:
        return 'claude'
    return None


def read_process(pid):
    p = Path('/proc') / str(pid)
    stat = (p / 'stat').read_text()
    fields = stat[stat.rfind(')') + 2:].split()
    args = [x.decode(errors='replace') for x in (p / 'cmdline').read_bytes().split(b'\0') if x]
    tool, role = classify(args, stat[stat.find('(') + 1:stat.rfind(')')])
    return {'pid': int(pid), 'ppid': int(fields[1]), 'start': int(fields[19]),
            'state': fields[0], 'tty': int(fields[4]), 'tool': tool, 'role': role,
            'cgroup': (p / 'cgroup').read_text().strip()}


def observe():
    ids = subprocess.check_output(['docker', 'ps', '-q'], text=True, timeout=20).split()
    if not ids:
        raise RuntimeError('No running root container')
    containers = json.loads(subprocess.check_output(['docker', 'inspect', *ids], text=True, timeout=25))
    root = next(c for c in containers if c['Name'] == '/hive-mind')
    root_pid = root['State']['Pid']
    processes = {}
    for p in Path('/proc').iterdir():
        if p.name.isdigit():
            try:
                row = read_process(p.name)
                processes[row['pid']] = row
            except (FileNotFoundError, ProcessLookupError):
                pass
    root_group = processes[root_pid]['cgroup']
    tasks = {'codex': [], 'claude': [], 'unknown': []}
    for c in containers:
        if c['Id'] == root['Id']:
            continue
        cmd = ' '.join(c['Config'].get('Cmd') or [])
        tool = command_tool(cmd)
        if tool or ('solve' in cmd and 'https://github.com/' in cmd):
            tasks[tool or 'unknown'].append(c['Name'].lstrip('/'))
    store = Path('/proc') / str(root_pid) / 'root/home/box/.start-command/executions.decoded.js.json'
    records = json.loads(store.read_text())
    def walk(value):
        if isinstance(value, dict):
            if value.get('uuid') and value.get('status') in ('executing', 'running', 'starting'):
                tasks[command_tool(value.get('command', '')) or 'unknown'].append(value['uuid'])
            for child in value.values():
                walk(child)
        elif isinstance(value, list):
            for child in value:
                walk(child)
    walk(records)
    return {'root_id': root['Id'], 'root_pid': root_pid, 'root_group': root_group,
            'processes': processes, 'tasks': tasks}


def plan(snapshot, tool):
    processes = snapshot['processes']
    own = [p for p in processes.values() if p['tool'] == tool and p['state'] != 'Z']
    candidates = [p for p in own if p['role'] != 'foreground']
    blockers = []
    if snapshot['tasks'][tool] or snapshot['tasks']['unknown']:
        blockers.append('active or unclassified task/execution')
    if any(p['role'] == 'foreground' for p in own):
        blockers.append('foreground CLI, login, interactive session or unknown mode')
    ids = {p['pid'] for p in candidates}
    for p in candidates:
        # Only the host or the root bot container. Never stop helpers in tasks.
        if any(x in p['cgroup'] for x in ('docker', 'containerd', 'kubepods', 'libpod')) and p['cgroup'] != snapshot['root_group']:
            blockers.append('helper is outside the host/root scope')
        if p['tty']:
            blockers.append('helper has a controlling terminal')
        if p['ppid'] not in ids | {1, snapshot['root_pid']}:
            blockers.append('helper still has a live owner')
        if any(x['ppid'] == p['pid'] and x['pid'] not in ids and x['state'] != 'Z' for x in processes.values()):
            blockers.append('helper has a live worker child')
    return sorted(candidates, key=lambda p: (p['role'] != 'updater', p['pid'])), sorted(set(blockers))


def same_process(expected, current):
    return current is not None and all(expected[k] == current[k] for k in ('pid', 'start', 'tool', 'role', 'cgroup'))


def stop_one(expected, sig, root_id, observer=observe):
    # pidfd binds the signal to this process incarnation, including escalation.
    fd = os.pidfd_open(expected['pid'])
    try:
        snapshot = observer()
        if snapshot['root_id'] != root_id:
            raise RuntimeError('Root container changed; cleanup stopped')
        candidates, blockers = plan(snapshot, expected['tool'])
        current = snapshot['processes'].get(expected['pid'])
        if not same_process(expected, current):
            return 'gone-or-changed'
        if blockers or expected['pid'] not in {p['pid'] for p in candidates}:
            return 'protected-by-new-work'
        signal.pidfd_send_signal(fd, sig)
        return 'signalled'
    finally:
        os.close(fd)


def main(params):
    tools = params.get('tools', ['codex', 'claude'])
    if not tools or any(t not in ('codex', 'claude') for t in tools):
        raise ValueError('tools must contain codex and/or claude')
    act = bool(params.get('act'))
    before = observe()
    result = {'acted': act, 'tools': tools, 'report': [], 'plans': [], 'signals': [], 'errors': []}
    for tool in tools:
        candidates, blockers = plan(before, tool)
        result['plans'].append({'tool': tool, 'pids': [p['pid'] for p in candidates], 'blockers': blockers})
        if not candidates:
            result['report'].append(tool + ': no recognized background services')
            continue
        if blockers:
            result['report'].append(tool + ': kept services: ' + '; '.join(blockers))
            continue
        if not act:
            result['report'].append(tool + ': would stop idle services ' + ', '.join(str(p['pid']) for p in candidates))
            continue
        for p in candidates:
            try:
                status = stop_one(p, signal.SIGTERM, before['root_id'])
            except ProcessLookupError:
                status = 'gone'
            result['signals'].append({'tool': tool, 'pid': p['pid'], 'signal': 'TERM', 'status': status})
        # Stop the updater first so it cannot resurrect the managed daemon.
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            alive = []
            for p in candidates:
                try:
                    now = read_process(p['pid'])
                    if same_process(p, now) and now['state'] != 'Z':
                        alive.append(p)
                except ProcessLookupError:
                    pass
                except FileNotFoundError:
                    pass
            if not alive:
                break
            time.sleep(0.2)
        for p in alive:
            try:
                status = stop_one(p, signal.SIGKILL, before['root_id'])
            except ProcessLookupError:
                status = 'gone'
            result['signals'].append({'tool': tool, 'pid': p['pid'], 'signal': 'KILL', 'status': status})
        result['report'].append(tool + ': cleanup attempted only for confirmed idle services; foreground and task processes protected')
    if act:
        time.sleep(2)
    after = observe()
    result['remaining'] = []
    for tool in tools:
        candidates, blockers = plan(after, tool)
        result['remaining'].append({'tool': tool, 'pids': [p['pid'] for p in candidates], 'blockers': blockers})
    result['clean'] = not any(x['pids'] for x in result['remaining'])
    return result


if __name__ == '__main__':
    params = json.load(sys.stdin)
    if params.get('act'):
        with open('/run/lock/auto-fix-tool-services.lock', 'a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            print(json.dumps(main(params)))
    else:
        print(json.dumps(main(params)))
