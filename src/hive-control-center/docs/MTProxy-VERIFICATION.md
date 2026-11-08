# MTProxy verification evidence

Verified on 2026-11-08 against `161.97.177.66:443` with the classic
`mtproxy-classic-443` container.

## Results

| Check | Result |
| --- | --- |
| Known-good profile | PASS, 15 checks, 0 mismatches |
| Telegram app proxy | match, `dd` prefix, app secret matches `/data/secret` |
| Text through MTProto API | PASS, `user=@drakonard`, marker read back and deleted |
| Document through MTProto API | PASS, 68 bytes uploaded, downloaded, SHA-256 matched, deleted |
| Photo through MTProto API | NOT VERIFIED, check added; latest run timed out before transfer |
| Bidirectional packet capture | PASS, client 8262 bytes, proxy 11901 bytes, 2 client connections |
| Path MTU | PASS, 1500-byte MTU / 1472-byte payload |
| TCPMSS | 1200 on ports 443 and 8443, both directions, service enabled/active |
| New app transport errors | none during the run |
| Idle client connections | about 1105-1131 clients, 12 active, most handshake-only, send queue 0 |

Direct Telegram DC connections from the client network are blocked, so the
diagnostics report them as `FAIL` without failing the run. Traffic through the
proxy worked during the runs above.

## Latest recheck limitation

After the photo check was added, TCP 443 still accepted connections and the API
client reached DC2. A retry sent and verified the text marker, then stalled on
the media upload with repeated `Ping timeout of 5.0s` and `Connection to dc 2
closed` events. A direct `--no-proxy` run also timed out. Current status:
messages work, media upload/download does not complete from this client network.
This is not a passing photo/media verification. Re-run after switching networks.

## Repeatable commands

Run from `src/hive-control-center/`:

```bash
node diagnose-mtproxy.mjs --api-test --no-report
TELEGRAM_ENV_FILE=/path/to/telegram.env node diagnose-mtproxy.mjs --api-test --no-report
TELEGRAM_ENV_FILE=/path/to/telegram.env node diagnose-mtproxy.mjs --api-media --no-report
TELEGRAM_APP_CONFIG=/path/to/accounts-shared-data TELEGRAM_ENV_FILE=/path/to/telegram.env node scripts/mtproxy/api-test.mjs --media
node scripts/mtproxy/api-test.mjs --no-proxy --env-file /path/to/telegram.env
node diagnose-mtproxy.mjs --capture --capture-seconds 20 --api-media --no-report
TELEGRAM_ENV_FILE=/path/to/telegram.env node diagnose-mtproxy.mjs --capture --capture-seconds 30 --api-media --no-report
```

Private values come from `.lenv`, `TELEGRAM_ENV_FILE`, or CLI paths. Never
commit `.lenv`, `.env`, `.telegram_session`, proxy secrets, API hashes, or SSH
passwords.

## Observed operational issue

During repeated testing the client source IP lost SSH authentication while
ping and TCP 443 still worked, matching the documented source-IP blackhole.
Switching networks or waiting restores SSH. The proxy itself stayed reachable
and served the API checks.

## Repository commits

- `3f58a3d`: import operational tooling.
- `760c758`: add API-based verification and mjs diagnostics.
- `58d5c53`: complete local source import and extend API media checks.
