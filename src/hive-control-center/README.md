# Hive Control Center operational tooling

Follow the [Hive Mind Manager migration runbook](../../docs/hive-manager-migration.md)
for the pinned release and supported deployment, diagnostics, recovery, and
MTProxy commands. The [inventory](../../docs/case-studies/issue-1/README.md)
lists release gaps and the live checks required before each caller moves.

## Legacy fallbacks

Keep the command used by the current deployment available until its replacement
passes the corresponding live checks. The fallback scripts live here.

- `deploy-docker.mjs`: local Docker deployment entry point.
- `deploy-remote-docker.mjs`: remote deployment over SSH/SFTP.
- `update-docker.mjs`: update the running hive-mind container and restart the bot.
- `diagnose-mtproxy.mjs`: end-to-end Telegram MTProto proxy diagnostics, including API text verification.
- `scripts/mtproxy/`: mjs parsers for app config, sockets, pcap, known-good profiles, API tests, and the proxy configuration matrix.
- `scripts/mtproxy/proxy-matrix.mjs`: redeploys and tests multiple proxy configurations, then keeps the best one.
- `auto-fix/`: host diagnostics and cleanup helpers.
- `docs/DEPLOY.md`: deployment and recovery runbook.
- `docs/MTProxy-MATRIX.md`: per-network proxy configuration matrix and selection logic.
- `docs/MTProxy-CONFIG-COVERAGE.md`: every MTProxy/deployment option and its tested status.
- `.lenv.example`: configuration template; copy it to `.lenv` and fill in values.

## Running the fallbacks

Run these commands from this directory so relative paths resolve:

```bash
cp .lenv.example .lenv
node deploy-remote-docker.mjs --mtproxy-only --mtproxy-update --verify-mtproxy
./diagnose-mtproxy.mjs --capture --restart-telegram --strict
TELEGRAM_ENV_FILE=/path/to/telegram.env ./diagnose-mtproxy.mjs --api-test --media-seconds 0
TELEGRAM_ENV_FILE=/path/to/telegram.env ./diagnose-mtproxy.mjs --api-media --media-seconds 0
node scripts/mtproxy/proxy-matrix.mjs --list
TELEGRAM_ENV_FILE=/path/to/telegram.env node scripts/mtproxy/proxy-matrix.mjs
node auto-fix.mjs --disk-report
```

Normal auto-fix runs print container disk use by task, including the container,
its `start-command` execution UUID and the GitHub issue or pull request. The
`--disk-report` mode adds images, volumes and host directories and writes
`data/disk-usage-*.json`.

If direct SSH to `SERVER_IP` is blocked, set `JUMP_HOST`, `JUMP_USER` and
`JUMP_PASS` in `.lenv` (optionally `JUMP_PORT`); auto-fix then reaches
`SERVER_IP` through that host automatically. The jump password is passed to
`sshpass` through the environment and is never printed.

Diagnostics are written to `data/diagnostics/` by default; the disk report is
written to `data/disk-usage-*.json`. Do not commit
`.lenv`, logs, captures, generated data, or server snapshots.

## Security

- `.lenv` contains SSH credentials and must stay local.
- Telegram bot tokens and MTProto secrets must never be printed or committed.
- The known-good profile stores only a secret hash, not the secret itself.
- Prefer the mjs helpers; do not add Python to these workflows.
