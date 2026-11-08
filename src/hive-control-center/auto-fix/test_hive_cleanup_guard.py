import importlib.util
import json
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('cleanup_guard', Path(__file__).with_name('hive-cleanup-guard.py'))
guard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guard)


class CleanupGuardTests(unittest.TestCase):
    def setUp(self):
        self.target = {'name': '11111111-1111-1111-1111-111111111111', 'id': 'a' * 64, 'exitCode': 1, 'finishedAt': '2026-10-30T00:00:00Z'}
        self.current = {'Id': self.target['id'], 'Name': '/' + self.target['name'], 'State': {'Running': False, 'Status': 'exited', 'ExitCode': 1, 'FinishedAt': self.target['finishedAt']}}

    def command(self, args):
        return guard.guarded_command(args, [self.target], lambda _: self.current)

    def test_force_request_becomes_unforced_removal_by_immutable_id(self):
        self.assertEqual(self.command(['rm', '-f', self.target['name']]), ['rm', self.target['id']])

    def test_restarted_task_is_kept(self):
        self.current['State'].update(Running=True, Status='running')
        with self.assertRaises(ValueError): self.command(['rm', '-f', self.target['name']])

    def test_later_failed_attempt_requires_a_new_backup(self):
        self.current['State']['FinishedAt'] = '2026-10-31T00:00:00Z'
        with self.assertRaises(ValueError): self.command(['rm', self.target['name']])

    def test_reused_name_or_wrong_id_is_kept(self):
        self.current['Id'] = 'b' * 64
        with self.assertRaises(ValueError): self.command(['rm', self.target['name']])

    def test_unselected_container_is_kept(self):
        with self.assertRaises(ValueError): self.command(['rm', '-f', '22222222-2222-2222-2222-222222222222'])

    def test_other_mutations_are_rejected(self):
        for args in [['system','prune','-f'],['kill',self.target['name']],['rmi','unused'],['rm','-v',self.target['name']],['rm',self.target['name'],'another']]:
            with self.subTest(args=args), self.assertRaises(ValueError): self.command(args)

    def test_read_only_listing_is_allowed(self):
        args = ['ps','-a','--format','{{json .}}']
        self.assertEqual(self.command(args), args)

    def test_listing_keeps_selected_failures_and_running_tasks_only(self):
        rows = [{'Names':self.target['name'],'State':'exited'}, {'Names':'live-task','State':'running'}, {'Names':'unselected-failure','State':'exited'}]
        text = '\n'.join(json.dumps(r) for r in rows)
        selected = [json.loads(s)['Names'] for s in guard.selected_ps_output(text, [self.target]).splitlines()]
        self.assertEqual(selected, [self.target['name'], 'live-task'])


if __name__ == '__main__': unittest.main()
