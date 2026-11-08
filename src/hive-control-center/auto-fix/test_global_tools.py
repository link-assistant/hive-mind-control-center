"""Safety/regression tests: python3 -m unittest discover -s auto-fix -p 'test_*.py'."""
import copy
import importlib.util
import json
import os
from pathlib import Path
import stat
import tempfile
import tomllib
import unittest

spec = importlib.util.spec_from_file_location('global_tools', Path(__file__).with_name('global-tools.py'))
guard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guard)


class GlobalToolBaselineTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.home = self.root / 'home'
        self.home.mkdir()
        self.backups = self.root / 'quarantine'

    def write(self, relative, value):
        path = self.home / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(value)
        return path

    def plan(self):
        return guard.Baseline(self.home, 'fixture', self.backups).plan()

    def seed(self):
        self.write('.codex/config.toml', '''model = "existing-model"
[plugins."leaked@market"]
enabled = true
[mcp_servers.playwright]
command = "npx"
args = ["-y", "@playwright/mcp@latest", "--isolated", "--headless", "--no-sandbox", "--timeout-action=600000", "--viewport-size", "1920x1080"]
[mcp_servers.unapproved]
url = "https://example.invalid/mcp"
[hooks]
Stop = [{ hooks = [{ type = "command", command = "never-execute-this" }] }]
''')
        self.write('.codex/plugins/cache/leaked/plugin.json', '{}')
        self.write('.codex/skills/leaked/SKILL.md', 'custom instructions')
        self.write('.codex/skills/.system/skill-creator/SKILL.md', 'stock fixture')
        self.write('.codex/skills/.system/not-stock/SKILL.md', 'custom instructions')
        self.write('.codex/hooks.json', '{"hooks":{"Stop":[]}}')
        self.write('.codex/.tmp/plugins/leaked.json', '{}')
        self.write('.claude/skills/synced/SKILL.md', 'synced global skill')
        self.write('.claude/plugins/installed_plugins.json', '{"plugins":{"leaked":[]}}')
        self.write('.claude/commands/leaked.md', 'custom command')
        self.write('.agents/skills/leaked/SKILL.md', 'cross-tool skill')
        self.write('.claude/settings.json', json.dumps({
            'model': 'existing-claude-model', 'hooks': {'Stop': []},
            'enabledPlugins': {'leaked@market': True},
            'env': {'API_TIMEOUT_MS': '123', 'CLAUDE_CODE_PLUGIN_CACHE_DIR': '/unexpected/cache'},
        }))
        self.write('.claude.json', json.dumps({
            'oauthAccount': {'accountUuid': 'synthetic-account'},
            'numStartups': 8,
            'mcpServers': {'playwright': {'type': 'stdio', **copy.deepcopy(guard.PLAYWRIGHT)}, 'other': {'command': 'not-allowed'}},
            'projects': {'/saved/project': {'lastSessionId': 'synthetic-session', 'mcpServers': {'other': {'command': 'not-allowed'}}}},
        }))
        for relative in [
            '.codex/auth.json', '.claude/.credentials.json',
            '.codex/sessions/rollout.jsonl', '.codex/archived_sessions/old.jsonl',
            '.codex/history.jsonl', '.codex/state_5.sqlite',
            '.claude/projects/project/session.jsonl', '.claude/sessions/session.json',
            '.codex/hive-mind/repositories/owner/repo/auth.json',
            '.codex/hive-mind/repositories/owner/repo/plugins/task-local.json',
        ]:
            self.write(relative, 'synthetic protected evidence: ' + relative)

    def snapshot(self):
        return {str(p.relative_to(self.home)): p.read_bytes() for p in self.home.rglob('*') if p.is_file() and not p.is_symlink()}

    def test_audit_is_read_only(self):
        self.seed()
        before = self.snapshot()
        plan = self.plan()
        self.assertTrue(plan.operations)
        self.assertFalse(plan.errors)
        self.assertEqual(before, self.snapshot())
        self.assertFalse(self.backups.exists())

    def test_cleanup_preserves_auth_history_task_scopes_and_config_inode(self):
        self.seed()
        before = self.snapshot()
        protected = {p: data for p, data in before.items() if '/sessions/' in p or '/projects/' in p or '/hive-mind/' in p or p.endswith(('auth.json', '.credentials.json', 'history.jsonl', '.sqlite'))}
        inode = (self.home / '.claude.json').stat().st_ino
        plan = self.plan()
        plan.apply()
        self.assertFalse(plan.errors)
        for relative, data in protected.items():
            self.assertEqual((self.home / relative).read_bytes(), data, relative)
        self.assertEqual((self.home / '.claude.json').stat().st_ino, inode)
        cfg = tomllib.loads((self.home / '.codex/config.toml').read_text())
        self.assertNotIn('plugins', cfg)
        self.assertNotIn('hooks', cfg)
        self.assertEqual(cfg['mcp_servers'], {'playwright': guard.PLAYWRIGHT})
        self.assertEqual(cfg['features'], {'remote_plugin': False, 'hooks': False})
        self.assertEqual(cfg['model'], 'existing-model')
        claude = json.loads((self.home / '.claude/settings.json').read_text())
        self.assertTrue(claude['disableAllHooks'])
        self.assertNotIn('enabledPlugins', claude)
        self.assertNotIn('CLAUDE_CODE_PLUGIN_CACHE_DIR', claude['env'])
        self.assertEqual(claude['env']['API_TIMEOUT_MS'], '123')
        identity = json.loads((self.home / '.claude.json').read_text())
        self.assertEqual(identity['oauthAccount'], {'accountUuid': 'synthetic-account'})
        self.assertEqual(identity['projects']['/saved/project']['lastSessionId'], 'synthetic-session')
        self.assertEqual(set(identity['mcpServers']), {'playwright'})
        self.assertEqual(stat.S_IMODE(Path(plan.backup).stat().st_mode), 0o700)
        self.assertEqual(stat.S_IMODE((Path(plan.backup) / 'config/.claude.json').stat().st_mode), 0o600)
        self.assertTrue((self.home / '.codex/skills/.system/skill-creator/SKILL.md').exists())
        self.assertFalse((self.home / '.codex/skills/.system/not-stock').exists())

    def test_second_run_is_clean(self):
        self.seed()
        self.plan().apply()
        second = self.plan()
        self.assertEqual(second.errors, [])
        self.assertEqual(second.operations, [])

    def test_empty_cache_scaffolding_is_not_contamination(self):
        self.plan().apply()
        (self.home / '.codex/plugins/cache/empty').mkdir(parents=True)
        self.assertEqual(self.plan().operations, [])

    def test_skill_symlink_is_quarantined_without_following_history(self):
        self.seed()
        target = self.home / '.codex/sessions'
        link = self.home / '.codex/skills/link-to-history'
        link.symlink_to(target, target_is_directory=True)
        self.plan().apply()
        self.assertFalse(os.path.lexists(link))
        self.assertTrue((target / 'rollout.jsonl').is_file())

    def test_config_symlink_cannot_overwrite_auth(self):
        auth = self.write('.claude/.credentials.json', '{"synthetic":"secret"}')
        cfg = self.home / '.claude/settings.json'
        cfg.symlink_to(auth)
        self.plan().apply()
        self.assertEqual(auth.read_text(), '{"synthetic":"secret"}')
        self.assertFalse(cfg.is_symlink())
        self.assertTrue(json.loads(cfg.read_text())['disableAllHooks'])

    def test_config_hardlink_to_auth_fails_closed(self):
        auth = self.write('.claude/.credentials.json', '{"synthetic":"secret"}')
        os.link(auth, self.home / '.claude/settings.json')
        plan = self.plan()
        self.assertTrue(plan.errors)
        plan.apply()
        self.assertEqual(auth.read_text(), '{"synthetic":"secret"}')
        self.assertFalse(self.backups.exists())

    def test_invalid_config_prevents_any_cleanup(self):
        self.seed()
        self.write('.codex/config.toml', '[invalid')
        before = self.snapshot()
        plan = self.plan()
        self.assertTrue(plan.errors)
        plan.apply()
        self.assertEqual(before, self.snapshot())
        self.assertFalse(self.backups.exists())

    def test_concurrent_config_change_prevents_any_cleanup(self):
        self.seed()
        plan = self.plan()
        self.write('.codex/config.toml', 'model = "changed"\n')
        before = self.snapshot()
        plan.apply()
        self.assertTrue(plan.errors)
        self.assertEqual(before, self.snapshot())

    def test_multiline_toml_and_profiles_are_parsed_not_regex_rewritten(self):
        self.write('.codex/config.toml', '''model = "existing-model"
description = """Keep this text:
[hooks]
Stop = "this is a string, not a hook"
"""
[[tools]]
name = "preserve"
[profiles.worker.plugins."leaked@market"]
enabled = true
''')
        self.plan().apply()
        cfg = tomllib.loads((self.home / '.codex/config.toml').read_text())
        self.assertIn('[hooks]', cfg['description'])
        self.assertEqual(cfg['tools'], [{'name': 'preserve'}])
        self.assertNotIn('plugins', cfg['profiles']['worker'])

    def test_protected_paths_cannot_be_cleanup_candidates(self):
        self.seed()
        plan = self.plan()
        for relative in guard.PROTECTED:
            if (self.home / relative).exists():
                with self.assertRaises(ValueError, msg=relative):
                    plan.remove(self.home / relative, 'invalid caller')

    def test_system_layers_remove_addons_but_keep_security_policy(self):
        system = self.root / 'etc/codex'
        system.mkdir(parents=True)
        (system / 'requirements.toml').write_text('allowed_approval_policies = ["on-request"]\n[hooks]\nStop = [{ hooks = [{type="command", command="never-run"}] }]\n')
        plan = guard.SystemBaseline(system, 'system-fixture', self.backups).plan()
        plan.apply()
        result = tomllib.loads((system / 'requirements.toml').read_text())
        self.assertEqual(result, {'allowed_approval_policies': ['on-request']})
        self.assertEqual(guard.SystemBaseline(system, 'system-fixture', self.backups).plan().operations, [])

    def test_managed_config_cannot_alias_user_credentials(self):
        auth = self.write('.claude/.credentials.json', '{"synthetic":"secret"}')
        system = self.root / 'etc/claude-code'
        system.mkdir(parents=True)
        os.link(auth, system / 'managed-settings.json')
        plan = guard.SystemBaseline(system, 'system-fixture', self.backups, [auth], claude=True).plan()
        self.assertTrue(plan.errors)
        plan.apply()
        self.assertEqual(auth.read_text(), '{"synthetic":"secret"}')
        (system / 'managed-settings.json').unlink()
        (system / 'managed-settings.json').write_text(json.dumps({'env': {'CLAUDE_CODE_PLUGIN_CACHE_DIR': '/unexpected', 'API_TIMEOUT_MS': '123'}, 'hooks': {'Stop': []}}))
        guard.SystemBaseline(system, 'system-fixture', self.backups, [auth], claude=True).plan().apply()
        clean = json.loads((system / 'managed-settings.json').read_text())
        self.assertEqual(clean, {'env': {'API_TIMEOUT_MS': '123'}})

    def test_redirected_global_tool_homes_cannot_report_false_clean(self):
        guard.validate_tool_environment({'HOME': '/home/box', 'CODEX_HOME': '/home/box/.codex'})
        for env in [{'CODEX_HOME': '/other'}, {'CLAUDE_CONFIG_DIR': '/other'}, {'CLAUDE_CODE_PLUGIN_CACHE_DIR': '/other'}, {'HOME': '/other'}]:
            with self.assertRaises(ValueError):
                guard.validate_tool_environment(env)


if __name__ == '__main__':
    unittest.main()
