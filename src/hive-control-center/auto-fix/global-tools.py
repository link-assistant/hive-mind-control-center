"""Server-only Claude/Codex global baseline; invoked by auto-fix.mjs.

No plugin/skill/hook code is executed. Removed add-ons and original config stay
in a root-only quarantine outside tool discovery. Auth, conversations, task
scopes and working trees are never cleanup candidates. Requires Python 3.11+.
"""
import copy
import datetime
import errno
import fcntl
import json
import os
from pathlib import Path
import shutil
import stat
import subprocess
import sys
import tomllib


STOCK_SKILLS = frozenset({
    'skill-installer', 'skill-creator', 'openai-docs', 'review-agent', 'imagegen',
    '.codex-system-skills.marker',
})
PLAYWRIGHT = {
    'command': 'npx',
    'args': ['-y', '@playwright/mcp@latest', '--isolated', '--headless',
             '--no-sandbox', '--timeout-action=600000', '--viewport-size', '1920x1080'],
}
ADDON_KEYS = frozenset({
    'hooks', 'plugins', 'plugin_marketplaces', 'skills', 'notify',
    'enabledPlugins', 'extraKnownMarketplaces', 'pluginConfigs', 'statusLine',
    'outputStyle', 'skillOverrides', 'agent', 'agents',
    'model_instructions_file', 'experimental_instructions_file',
})
UNSAFE_ENV = frozenset({
    'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_PLUGIN_CACHE_DIR',
    'CLAUDE_PLUGIN_ROOT', 'PLUGIN_ROOT',
    'CLAUDE_CODE_ENABLE_BACKGROUND_PLUGIN_REFRESH', 'FORCE_AUTOUPDATE_PLUGINS',
})
# Deleting directories below these would destroy evidence. Match lexical paths
# too: a malicious skill symlink must be unlinked, never followed into history.
PROTECTED = (
    '.codex/auth.json', '.claude/.credentials.json',
    '.codex/sessions', '.codex/archived_sessions', '.codex/history.jsonl',
    '.codex/session_index.jsonl', '.codex/hive-mind', '.codex/generated_images',
    '.claude/projects', '.claude/sessions', '.claude/history.jsonl',
)
ADDON_PATHS = (
    '.codex/plugins', '.codex/hooks', '.codex/hooks.json', '.codex/.hook-trust',
    '.codex/.tmp/plugins', '.codex/.tmp/plugins.sha', '.codex/.tmp/plugins.sync.lock',
    '.codex/AGENTS.md', '.codex/AGENTS.override.md', '.codex/instructions.md',
    '.codex/agents', '.codex/prompts', '.codex/rules',
    '.claude/skills', '.claude/plugins', '.claude/hooks', '.claude/agents',
    '.claude/commands', '.claude/output-styles', '.claude/CLAUDE.md',
    '.claude/CLAUDE.local.md', '.agents/skills', 'AGENTS.md', 'CLAUDE.md', 'CLAUDE.local.md',
)


def lexists(path):
    return os.path.lexists(path)


def toml_value(value):
    if isinstance(value, bool):
        return 'true' if value else 'false'
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=False)
    if isinstance(value, (int, float)):
        return repr(value)
    if isinstance(value, (datetime.datetime, datetime.date, datetime.time)):
        return value.isoformat()
    if isinstance(value, list):
        return '[' + ', '.join(toml_value(v) for v in value) + ']'
    if isinstance(value, dict):
        return '{ ' + ', '.join(json.dumps(k) + ' = ' + toml_value(v) for k, v in value.items()) + ' }'
    raise ValueError('Unsupported TOML value; refusing a lossy configuration rewrite')


def dump_toml(data):
    result = ''.join(json.dumps(k) + ' = ' + toml_value(v) + '\n' for k, v in data.items())
    if tomllib.loads(result) != data:
        raise ValueError('TOML roundtrip failed')
    return result.encode()


def sanitized_config(data, kind, defaults=False):
    """Only remove extension surfaces. Preserve auth/identity/history metadata."""
    result = copy.deepcopy(data)
    for key in ADDON_KEYS:
        result.pop(key, None)
    for key in ('mcp_servers', 'mcpServers'):
        if key in result:
            servers = result[key]
            if not isinstance(servers, dict):
                raise ValueError('MCP configuration is not an object')
            result[key] = {k: v for k, v in servers.items() if k == 'playwright'}
    if kind == 'codex':
        profiles = result.get('profiles', {})
        if isinstance(profiles, dict):
            for key, profile in profiles.items():
                if isinstance(profile, dict):
                    profiles[key] = sanitized_config(profile, kind)
        if defaults:
            features = result.setdefault('features', {})
            if not isinstance(features, dict):
                raise ValueError('Codex features must be a table')
            features.pop('codex_hooks', None)
            features.update(remote_plugin=False, hooks=False)
            result.setdefault('mcp_servers', {})['playwright'] = copy.deepcopy(PLAYWRIGHT)
    else:
        if 'env' in result:
            if not isinstance(result['env'], dict):
                raise ValueError('Claude env must be an object')
            for key in UNSAFE_ENV:
                result['env'].pop(key, None)
        if isinstance(result.get('projects'), dict):
            for key, project in result['projects'].items():
                if isinstance(project, dict):
                    result['projects'][key] = sanitized_config(project, kind)
        if defaults and kind == 'claude':
            result['disableAllHooks'] = True
            env = result.setdefault('env', {})
            if not isinstance(env, dict):
                raise ValueError('Claude env must be an object')
            env['CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL'] = '1'
        if kind == 'claude-mcp' and defaults:
            result.setdefault('mcpServers', {})['playwright'] = {'type': 'stdio', **copy.deepcopy(PLAYWRIGHT)}
    return result


class Baseline:
    def __init__(self, home, label, backup_root, protected_paths=()):
        self.home = Path(home)
        self.label = label
        self.backup_root = Path(backup_root)
        self.operations = []
        self.errors = []
        self.protection_paths = [self.home / p for p in PROTECTED] + list(protected_paths)

    def relative(self, path):
        relative = Path(path).relative_to(self.home)
        if '..' in relative.parts or not relative.parts:
            raise ValueError('Path outside tool home')
        return relative.as_posix()

    def protected(self, path):
        rel = self.relative(path)
        return any(rel == p or rel.startswith(p + '/') or p.startswith(rel + '/') for p in PROTECTED)

    def remove(self, path, reason):
        if not lexists(path):
            return
        # CLIs may recreate empty cache scaffolding. That is not an installed
        # extension and must not cause an endless cleanup/alert loop.
        if Path(path).is_dir() and not Path(path).is_symlink():
            if not any(files or any((Path(base) / d).is_symlink() for d in dirs)
                       for base, dirs, files in os.walk(path, followlinks=False)):
                return
        if self.protected(path):
            raise ValueError('Refusing to quarantine protected state')
        # An ancestor symlink could make a config file point into auth/history.
        # Directory symlinks are safe to quarantine as links without traversal.
        if not Path(path).is_symlink():
            target = Path(path).resolve()
            for p in self.protection_paths:
                if p.exists():
                    resolved = p.resolve()
                    if target == resolved or target in resolved.parents:
                        raise ValueError('Add-on path aliases protected state')
        self.operations.append({'op': 'quarantine', 'path': Path(path), 'reason': reason})

    def config(self, relative, kind, defaults=False):
        path = self.home / relative
        existed = lexists(path)
        if existed and path.is_symlink():
            # Refuse writing through a malicious config link. Remove the link
            # and create the safe config only after the whole plan validates.
            self.remove(path, 'configuration symlink redirects global state')
            raw, data = None, {}
        elif existed:
            # A hard link is not caught by realpath/symlink checks. Never edit
            # a config whose inode is actually a credential or history file.
            identity = (path.stat().st_dev, path.stat().st_ino)
            for protected in self.protection_paths:
                if protected.exists():
                    s = protected.stat()
                    if identity == (s.st_dev, s.st_ino):
                        raise ValueError('Configuration aliases protected state')
            raw = path.read_bytes()
            data = tomllib.loads(raw.decode()) if kind == 'codex' else json.loads(raw)
            if not isinstance(data, dict):
                raise ValueError('Configuration must be an object')
        else:
            raw, data = None, {}
        clean = sanitized_config(data, kind, defaults)
        if clean != data or (raw is None and defaults):
            new_raw = dump_toml(clean) if kind == 'codex' else (json.dumps(clean, indent=2, ensure_ascii=False) + '\n').encode()
            self.operations.append({'op': 'config', 'path': path, 'reason': 'remove global add-ons; enforce Playwright-only baseline', 'before': raw, 'after': new_raw})

    def plan(self):
        try:
            for rel in ADDON_PATHS:
                self.remove(self.home / rel, 'global extension/instruction state')
            skills = self.home / '.codex/skills'
            if skills.is_symlink():
                self.remove(skills, 'redirected global skills')
            elif skills.exists():
                for path in skills.iterdir():
                    if path.name != '.system' or path.is_symlink():
                        self.remove(path, 'non-stock global skill')
                    elif path.is_dir():
                        for child in path.iterdir():
                            if child.name not in STOCK_SKILLS or child.is_symlink():
                                self.remove(child, 'unexpected addition to vendor system skills')
            self.config('.codex/config.toml', 'codex', defaults=True)
            self.config('.claude/settings.json', 'claude', defaults=True)
            if lexists(self.home / '.claude/settings.local.json'):
                self.config('.claude/settings.local.json', 'claude', defaults=True)
            self.config('.claude.json', 'claude-mcp', defaults=True)
            if lexists(self.home / '.mcp.json'):
                self.config('.mcp.json', 'claude-mcp')
        except Exception as error:
            # Never print config values or exception text containing tokens.
            self.errors.append(type(error).__name__ + ': cannot safely plan global cleanup')
        return self

    def write_protected(self, path, raw):
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, 'wb') as handle:
            handle.write(raw)
            handle.flush()
            os.fsync(handle.fileno())

    def apply(self):
        if self.errors:
            return
        # Validate every config version before doing any mutation.
        for operation in self.operations:
            if operation['op'] == 'config' and operation['before'] is not None:
                if operation['path'].read_bytes() != operation['before']:
                    self.errors.append('Concurrent config change; cleanup aborted')
                    return
        if not self.operations:
            return
        timestamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S.%fZ')
        backup = self.backup_root / timestamp / self.label
        backup.mkdir(parents=True, mode=0o700)
        # Back up all config first; bytes remain server-side, outside discovery.
        for operation in self.operations:
            if operation['op'] == 'config' and operation['before'] is not None:
                self.write_protected(backup / 'config' / self.relative(operation['path']), operation['before'])
        for operation in self.operations:
            path = operation['path']
            if operation['op'] == 'quarantine':
                target = backup / 'removed' / self.relative(path)
                target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
                try:
                    os.rename(path, target)
                except OSError as error:
                    if error.errno != errno.EXDEV:
                        raise
                    if path.is_symlink():
                        target.symlink_to(os.readlink(path))
                        path.unlink()
                    elif path.is_dir():
                        shutil.copytree(path, target, symlinks=True)
                        shutil.rmtree(path)
                    else:
                        shutil.copy2(path, target, follow_symlinks=False)
                        path.unlink()
            else:
                path.parent.mkdir(parents=True, exist_ok=True)
                before_stat = path.stat() if path.exists() else None
                fd = os.open(path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
                try:
                    fcntl.flock(fd, fcntl.LOCK_EX)
                    current = os.pread(fd, os.fstat(fd).st_size + 1, 0)
                    if operation['before'] is not None and current != operation['before']:
                        raise RuntimeError('Config changed during cleanup; protected backup retained')
                    raw = operation['after']
                    try:
                        if os.pwrite(fd, raw, 0) != len(raw):
                            raise RuntimeError('Incomplete config write')
                        os.ftruncate(fd, len(raw))
                        os.fsync(fd)
                    except Exception:
                        if operation['before'] is not None:
                            os.pwrite(fd, operation['before'], 0)
                            os.ftruncate(fd, len(operation['before']))
                            os.fsync(fd)
                        raise
                    if before_stat:
                        after_stat = os.fstat(fd)
                        if (before_stat.st_dev, before_stat.st_ino) != (after_stat.st_dev, after_stat.st_ino):
                            raise RuntimeError('Config inode changed')
                    else:
                        parent_stat = path.parent.stat()
                        os.fchown(fd, parent_stat.st_uid, parent_stat.st_gid)
                finally:
                    os.close(fd)
        self.backup = str(backup)

    def result(self):
        return {
            'context': self.label,
            'findings': [{'path': self.relative(o['path']), 'action': o['op'], 'reason': o['reason']} for o in self.operations],
            'errors': self.errors,
            'backup': getattr(self, 'backup', None),
        }


class SystemBaseline(Baseline):
    """Inspect managed/global layers too, without removing security policies."""
    def __init__(self, home, label, backup_root, protected_paths=(), claude=False):
        super().__init__(home, label, backup_root, protected_paths)
        self.claude = claude

    def plan(self):
        try:
            for rel in ('skills', 'plugins', 'hooks', 'hooks.json', 'agents', 'commands'):
                self.remove(self.home / rel, 'system-global extension state')
            configs = [('managed-settings.json', 'claude')] if self.claude else [('config.toml', 'codex'), ('requirements.toml', 'codex')]
            for relative, kind in configs:
                if lexists(self.home / relative):
                    self.config(relative, kind)
        except Exception as error:
            self.errors.append(type(error).__name__ + ': cannot safely plan system-global cleanup')
        return self


def docker(*args):
    return subprocess.check_output(['docker', *args], text=True, timeout=30)


def validate_tool_environment(env):
    expected = {'HOME': '/home/box', 'CODEX_HOME': '/home/box/.codex', 'CLAUDE_CONFIG_DIR': '/home/box/.claude'}
    for key, default in expected.items():
        if env.get(key) and os.path.normpath(env[key]) != default:
            raise ValueError('Unsupported root-container ' + key + ' override; effective global state cannot be certified')
    if env.get('CLAUDE_CODE_PLUGIN_CACHE_DIR'):
        raise ValueError('Root-container CLAUDE_CODE_PLUGIN_CACHE_DIR redirects global state; cleanup refused')


def main():
    params = json.load(sys.stdin)
    act = bool(params.get('act'))
    if os.geteuid() != 0:
        raise RuntimeError('Server global baseline must run as root')
    containers = json.loads(docker('inspect', 'hive-mind'))
    container = containers[0]
    validate_tool_environment(dict(v.split('=', 1) for v in container['Config'].get('Env', []) if '=' in v))
    if not container['State']['Running']:
        raise RuntimeError('hive-mind container must be running')
    rootfs = Path('/proc') / str(container['State']['Pid']) / 'root'
    # No arbitrary paths supplied by task/config/user content are accepted.
    backup_root = Path('/root/auto-fix/global-tools-backups')
    contexts = [('bot-user', rootfs / 'home/box', 'user')]
    for label, home in [('bot-root', rootfs / 'root'), ('host-root', Path('/root'))]:
        if any(lexists(home / p) for p in ('.codex', '.claude', '.claude.json', '.agents/skills')):
            contexts.append((label, home, 'user'))
    protected_paths = [home / p for _, home, _ in contexts for p in PROTECTED]
    for prefix, fsroot in [('bot', rootfs), ('host', Path('/'))]:
        for relative, mode in [('etc/codex', 'codex'), ('etc/claude-code', 'claude')]:
            base = fsroot / relative
            if base.is_dir():
                contexts.append((prefix + '-system-' + mode, base, mode))
    def make_plans():
        plans = []
        for label, home, mode in contexts:
            plan = Baseline(home, label, backup_root, protected_paths) if mode == 'user' else SystemBaseline(home, label, backup_root, protected_paths, claude=mode == 'claude')
            plans.append(plan.plan())
        return plans
    plans = make_plans()
    if act and not any(p.errors for p in plans):
        backup_root.mkdir(parents=True, exist_ok=True, mode=0o700)
        if backup_root.is_symlink() or backup_root.stat().st_uid != 0:
            raise RuntimeError('Unsafe backup directory')
        os.chmod(backup_root, 0o700)
        lock_path = backup_root / '.lock'
        lock_fd = os.open(lock_path, os.O_WRONLY | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        try:
            fcntl.flock(lock_fd, fcntl.LOCK_EX)
            # Another auto-fix process may have cleaned while this one waited.
            plans = make_plans()
            if not any(p.errors for p in plans):
                for plan in plans:
                    plan.apply()
        finally:
            os.close(lock_fd)
    remaining = [p.result() for p in make_plans()] if act else [p.result() for p in plans]
    clean = not any(p['findings'] or p['errors'] for p in remaining)
    report = []
    for plan in plans:
        result = plan.result()
        for item in result['findings']:
            report.append(f"{result['context']}: {'removed/reconciled' if act and result['backup'] else 'found'} {item['path']} ({item['reason']})")
        for error in result['errors']:
            report.append(f"ERROR {result['context']}: {error}")
    report.append('Global Claude/Codex baseline: ' + ('clean (Playwright MCP only; stock CLI system skills are vendor-provided)' if clean else 'violations remain'))
    print(json.dumps({'acted': act, 'clean': clean, 'report': report, 'contexts': [p.result() for p in plans], 'remaining': remaining}))


if __name__ == '__main__':
    main()
