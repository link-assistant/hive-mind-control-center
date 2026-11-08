"""Service cleanup safety: synthetic processes only, no live Claude execution."""
import copy
import importlib.util
from pathlib import Path
import signal
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('tool_services', Path(__file__).with_name('tool-services.py'))
guard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guard)


def process(pid, role, tool='codex', ppid=1, **extra):
    return dict(pid=pid, ppid=ppid, start=pid * 100, state='S', tty=0,
                tool=tool, role=role, cgroup='root', **extra)


def snapshot():
    return {'root_id': 'root-fixture', 'root_pid': 1, 'root_group': 'root',
            'tasks': {'codex': [], 'claude': ['active-claude'], 'unknown': []},
            'processes': {10: process(10, 'updater'), 11: process(11, 'managed-daemon', ppid=10),
                          20: process(20, 'foreground', 'claude')}}


class ToolServiceTests(unittest.TestCase):
    def test_known_daemons_and_foreground_modes(self):
        for args, expected in [
            (['codex', 'app-server', 'daemon', 'pid-update-loop'], ('codex', 'updater')),
            (['codex', 'app-server', '--listen', 'unix://', '--managed-daemon'], ('codex', 'managed-daemon')),
            (['node', '/pkg/bin/codex.js', 'app-server', '--managed-daemon'], ('codex', 'managed-daemon')),
            (['codex', 'exec', 'prompt'], ('codex', 'foreground')),
            (['codex', 'login'], ('codex', 'foreground')),
            (['codex', 'app-server'], ('codex', 'foreground')),
            (['claude', '--claude-in-chrome-mcp'], ('claude', 'browser-helper')),
            (['claude', '--chrome-native-host'], ('claude', 'browser-helper')),
            (['claude', '--print', 'prompt'], ('claude', 'foreground')),
            (['claude', 'remote-control'], ('claude', 'foreground')),
            (['python3', '-c', 'codex'], (None, None)),
        ]:
            with self.subTest(args=args):
                self.assertEqual(guard.classify(args, args[0]), expected)

    def test_codex_cleanup_does_not_depend_on_claude_being_idle(self):
        candidates, blockers = guard.plan(snapshot(), 'codex')
        self.assertEqual([p['pid'] for p in candidates], [10, 11])
        self.assertEqual(blockers, [])
        self.assertTrue(guard.plan(snapshot(), 'claude')[1])

    def test_tasks_foreground_terminal_owner_worker_and_other_containers_protect(self):
        for mutation in [
            lambda s: s['tasks']['codex'].append('new-task'),
            lambda s: s['tasks']['unknown'].append('unknown-task'),
            lambda s: s['processes'].update({30: process(30, 'foreground')}),
            lambda s: s['processes'][10].update(tty=123),
            lambda s: s['processes'][10].update(ppid=900),
            lambda s: s['processes'].update({30: process(30, None, None, ppid=11)}),
            lambda s: s['processes'][11].update(cgroup='/docker/other-task'),
        ]:
            with self.subTest(mutation=mutation):
                s = snapshot(); mutation(s)
                self.assertTrue(guard.plan(s, 'codex')[1])

    def test_dry_run_never_opens_pidfd_or_sends_signal(self):
        with patch.object(guard, 'observe', return_value=snapshot()), patch.object(guard.os, 'pidfd_open', create=True) as opened, patch.object(guard.signal, 'pidfd_send_signal', create=True) as sent:
            r = guard.main({'act': False, 'tools': ['codex']})
            self.assertFalse(r['acted']); self.assertFalse(r['clean'])
            opened.assert_not_called(); sent.assert_not_called()

    def test_pid_reuse_and_new_tasks_prevent_signals(self):
        for change in ['start', 'tool', 'role', 'cgroup', 'new-task']:
            s = snapshot(); expected = copy.deepcopy(s['processes'][10])
            if change == 'new-task': s['tasks']['codex'].append('admitted-during-cleanup')
            else: s['processes'][10][change] = 'changed'
            with self.subTest(change=change), patch.object(guard.os, 'pidfd_open', return_value=42, create=True), patch.object(guard.os, 'close') as closed, patch.object(guard.signal, 'pidfd_send_signal', create=True) as sent:
                guard.stop_one(expected, signal.SIGTERM, 'root-fixture', lambda: s)
                sent.assert_not_called(); closed.assert_called_once_with(42)

    def test_signals_use_stable_pidfd_for_term_and_escalation(self):
        s = snapshot()
        for sig in [signal.SIGTERM, signal.SIGKILL]:
            with self.subTest(signal=sig), patch.object(guard.os, 'pidfd_open', return_value=42, create=True), patch.object(guard.os, 'close'), patch.object(guard.signal, 'pidfd_send_signal', create=True) as sent:
                self.assertEqual(guard.stop_one(s['processes'][10], sig, 'root-fixture', lambda: s), 'signalled')
                sent.assert_called_once_with(42, sig)

    def test_claude_helpers_are_only_eligible_without_claude_work(self):
        s = snapshot(); s['tasks']['claude'] = []
        s['processes'][20].update(role='browser-helper')
        self.assertFalse(guard.plan(s, 'claude')[1])
        s['tasks']['claude'].append('running-claude-task')
        self.assertTrue(guard.plan(s, 'claude')[1])

    def test_shell_command_tool_detection(self):
        self.assertEqual(guard.command_tool("exec 'solve' 'https://github.com/a/b/issues/1' '--tool' 'codex'"), 'codex')
        self.assertEqual(guard.command_tool('solve https://github.com/a/b/issues/1 --tool=claude'), 'claude')
        self.assertIsNone(guard.command_tool('unclassified detached work'))


if __name__ == '__main__':
    unittest.main()
