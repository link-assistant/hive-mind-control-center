Idle tool services
==================

Normal auto-fix checks idle Codex/Claude services before recovery and on each
monitor poll. `--diagnose` audits them without stopping anything.

Run only the scoped service cleanup:

```sh
node auto-fix.mjs --tool-services-only --service-tools codex --dry-run
node auto-fix.mjs --tool-services-only --service-tools codex
```

`--service-tools codex,claude` is the default. `--no-stop-idle-tool-services`
audits only. This mode does not run tool probes, global configuration cleanup,
task recovery, reporting or disk cleanup. Results: `data/tool-services-last.json`.

Known Codex targets are the managed app-server and its `daemon pid-update-loop`.
The updater stops first to prevent child resurrection. Known Claude targets
are orphan browser MCP/native-host helpers. Unknown modes, login, foreground
execution, remote-control and generic MCP serving are protected.

A matching active task, unknown execution, foreground CLI, controlling terminal,
live owner, worker child or task-container scope defers cleanup for that tool.
Each signal rechecks task state, root-container identity, process start ticks,
role and cgroup, and uses a Linux pidfd. Graceful termination precedes bounded
escalation. No authentication or conversation/configuration files are edited.
Only one cleanup may act at a time.

This is a maintenance workaround. Hive Mind's queue must classify active work
and ignore idle daemon PIDs rather than requiring vendor services to be stopped.
Codex was tested live on 2026-11-04; Claude has synthetic safety coverage only.
No Claude cleanup was tested on the live server.

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s auto-fix -p 'test_tool_services.py' -v
```
