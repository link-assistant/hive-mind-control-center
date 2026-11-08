"""Docker adapter for a scoped hive-cleanup run. Never force-removes a task."""
import json
import os
import subprocess
import sys


def guarded_command(args, targets, inspect):
    if not args:
        raise ValueError('Missing Docker command')
    if args[0] in ('ps', 'inspect', 'info', 'version'):
        return list(args)
    if args[0] != 'rm':
        raise ValueError('Docker mutation is outside this cleanup scope')
    names = [a for a in args[1:] if a not in ('-f', '--force')]
    if len(names) != 1 or names[0].startswith('-'):
        raise ValueError('Only one explicitly selected container may be removed')
    target = next((t for t in targets if names[0] in (t['name'], t['id'])), None)
    if target is None:
        raise ValueError('Container was not selected and preserved')
    current = inspect(target['id'])
    state = current['State']
    if current['Id'] != target['id'] or current['Name'].lstrip('/') != target['name']:
        raise ValueError('Container identity changed')
    if state.get('Running') or state.get('Status') != 'exited':
        raise ValueError('Container is no longer a stopped failure')
    if state.get('ExitCode') != target['exitCode'] or state.get('FinishedAt') != target['finishedAt']:
        raise ValueError('Container changed after preservation')
    # hive-cleanup currently asks for `rm -f`; remove -f and use the immutable ID.
    # Docker itself then rejects a concurrent restart, even after our inspection.
    return ['rm', target['id']]


def selected_ps_output(output, targets):
    names = {t['name'] for t in targets}
    selected = []
    for line in output.splitlines():
        if not line.strip():
            continue
        row = json.loads(line)
        running = row.get('State') == 'running' or str(row.get('Status', '')).startswith('Up')
        if running or row.get('Names') in names:
            selected.append(line)
    return '\n'.join(selected) + ('\n' if selected else '')


def main():
    real = os.environ['AF_REAL_DOCKER']
    with open(os.environ['AF_CLEANUP_TARGETS']) as f:
        targets = json.load(f)

    def inspect(container_id):
        result = subprocess.run([real, 'inspect', container_id], check=True, capture_output=True, text=True, timeout=30)
        return json.loads(result.stdout)[0]

    original = sys.argv[1:]
    args = guarded_command(original, targets, inspect)
    if original == ['ps', '-a', '--format', '{{json .}}']:
        # `{{json .}}` asks Docker for Size too: containerd then walks every
        # writable layer, often longer than hive-cleanup's 20-second timeout.
        # Request just the planner's fields so discovery remains size-free.
        template = '{"ID":{{json .ID}},"Names":{{json .Names}},"State":{{json .State}},"Status":{{json .Status}},"Image":{{json .Image}},"Command":{{json .Command}}}'
        result = subprocess.run([real, 'ps', '-a', '--format', template], check=True, capture_output=True, text=True, timeout=30)
        sys.stdout.write(selected_ps_output(result.stdout, targets))
        return
    os.execv(real, [real, *args])


if __name__ == '__main__':
    try:
        main()
    except (ValueError, KeyError, OSError, subprocess.SubprocessError) as error:
        print('auto-fix cleanup guard: ' + str(error), file=sys.stderr)
        sys.exit(1)
