# Hive Control Center operational tooling

This directory contains the operational scripts imported from the local
`hive-control-center` workspace: deployment, diagnostics, recovery, and
auto-fix tooling for the hive-mind host and its optional MTProto proxy.

## Layout

- `deploy-docker.mjs`: local Docker deployment entry point.
- `deploy-remote-docker.mjs`: remote deployment over SSH/SFTP.
- `update-docker.mjs`: update the running hive-mind container and restart the bot.
- `diagnose-mtproxy.mjs`: end-to-end Telegram MTProto proxy diagnostics, including API text verification.
- `scripts/mtproxy/`: mjs parsers for app config, sockets, pcap, and known-good profiles.
- `auto-fix/`: host diagnostics and cleanup helpers.
- `docs/DEPLOY.md`: deployment and recovery runbook.
- `.lenv.example`: configuration template; copy it to `.lenv` and fill in values.

## Usage

Run these commands from this directory so relative paths resolve:

```bash
cp .lenv.example .lenv
node deploy-remote-docker.mjs --mtproxy-only --mtproxy-update --verify-mtproxy
./diagnose-mtproxy.mjs --capture --restart-telegram --strict
TELEGRAM_ENV_FILE=/path/to/telegram.env ./diagnose-mtproxy.mjs --api-test --media-seconds 0
TELEGRAM_ENV_FILE=/path/to/telegram.env ./diagnose-mtproxy.mjs --api-media --media-seconds 0
```

Diagnostics are written to `data/diagnostics/` by default. Do not commit
`.lenv`, logs, captures, generated data, or server snapshots.

## Security

- `.lenv` contains SSH credentials and must stay local.
- Telegram bot tokens and MTProto secrets must never be printed or committed.
- The known-good profile stores only a secret hash, not the secret itself.
- Prefer the mjs helpers; do not add Python to these workflows.
