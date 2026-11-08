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
| Idle client connections | 994 established; 842 inbound clients, 144 outbound DC sockets |
| Container file limit | explicit `nofile=524288:524288`; engine needs 65552 |

Direct Telegram DC connections from the client network are blocked, so the
diagnostics report them as `FAIL` without failing the run. Traffic through the
proxy worked during the runs above.

## Latest recheck limitation

After the photo check was added, TCP 443 still accepted connections and the API
client reached DC2. A retry sent and verified the text marker, then stalled on
the media upload with repeated `Ping timeout of 5.0s` and `Connection to dc 2
closed` events. A direct `--no-proxy` run also timed out.

Server-side inspection showed the container was healthy but held 994 established
sockets, including 842 inbound clients and 144 outbound Telegram DC sockets. The
2019 image's `/run.sh` hardcodes `-C 60000` and asks the kernel for 65552 open
files; recreating the container with `--ulimit nofile=524288:524288` fixed a
crash-loop seen with a lower hard limit. A restart cleared the connection
backlog and text passed again, but media still stalled.

A current `telegrammessenger/proxy:2.0beta` image (April 2026 build) was also
tested on port 8443 with the same secret. It produced the same ping timeouts, so
the proxy binary/version is not the cause. The common variable is the client
network path, which also blocks direct DC connections.

A TLS-camouflaged/FakeTLS transport was then tested on port 443: `mtg 2.3.0`
with an `ee` secret using `contabo.com` fronting. It accepted the connection but
text did not complete, so it was rolled back to the classic container. Classic
text passed again after a retry. Switching networks is explicitly out of scope.

After restoring the classic container with 4 workers, text passed immediately
(`API_TEST_SENT=yes`, `API_TEST_CLEANED=yes`, `API_TEST_STATUS=PASS`). Media
still did not complete: uploads stalled, `@telegram` message history timed out,
and `downloadProfilePhoto('@telegram'|'me')` timed out. `getMessages('me',
{limit:1})` did return, but there was no photo to download.

Current status: messages work, media upload/download does not complete from this
client network. This is not a passing photo/media verification.

## Configuration matrix (tested 2026-11-08)

All rows were tested from the same client network; no network switch was used.
"Connect" means the client reached DC2 or the proxy but did not complete a
request; "text" means the Saved Messages marker was sent, read back, and deleted.

| # | Proxy / image | Transport and port | Workers, limits | Secret / fronting | Result |
| --- | --- | --- | --- | --- | --- |
| 1 | classic `mtproxy/mtproxy:latest` (2019) | HTTP `-H 443`, app port 443 | 1, `nofile=65536` | `dd` key | Startup failed: `cannot raise open file limit to 65552` |
| 2 | classic 2019 | HTTP `-H 443`, app port 443 | 1, `nofile=524288` | `dd` key | Text PASS; media upload FAIL (ping timeouts) |
| 3 | classic 2019 | HTTP `-H 443`, app port 443 | 4, `nofile=524288` | `dd` key | Text PASS immediately; media upload, `@telegram` receive, and profile-photo download FAIL |
| 4 | classic 2019 | `INTERNAL_PORT=443 PORT=8888` | 1, `nofile=524288` | `dd` key | No listener on 443 (only 8888); discarded |
| 5 | `telegrammessenger/proxy:2.0beta` (2026-04) | HTTP `-H 443`, host 8443 | default | same `dd` key | Connects; media FAIL, same ping timeouts |
| 6 | mtg 2.3.0 FakeTLS | TLS/443 | default | `ee` secret, `contabo.com` | Connects; text FAIL |
| 7 | mtg 2.3.0 FakeTLS | TLS/443 | default | `ee` secret, `www.google.com` | Connects; text FAIL |
| 8 | mtg 2.3.0 FakeTLS | TLS/443 | default | `ee` secret, `vk.com` | Connects; text FAIL |
| 9 | mtg 2.3.0 `simple-run` | plain MTProto/443 | default | raw `dd<key>` or 32-hex key | Startup rejected: incorrect first secret byte |
| 10 | direct (no proxy) | Telegram DC 443 | n/a | n/a | Text/media requests time out from this client |
| 11 | classic 2019 | receive-only API | 4, `nofile=524288` | `dd` key | `getMessages('me',limit:1)` completes (no photo); `@telegram` history and profile photos time out |

Interpretation: the failure follows the **media/file path**, not one engine.
Text-sized requests complete; requests that require a larger or longer-lived
transfer do not, and direct DC connections fail too. The next useful test is a
real Telegram-client download through a TLS-encrypted TCP tunnel, because the
API client's own 5-second ping guard also closes slow media sessions. That test
is not yet run.

## Repeatable commands

Run from `src/hive-control-center/`:

```bash
node diagnose-mtproxy.mjs --api-test --no-report
TELEGRAM_ENV_FILE=/path/to/telegram.env node diagnose-mtproxy.mjs --api-test --no-report
TELEGRAM_ENV_FILE=/path/to/telegram.env node diagnose-mtproxy.mjs --api-media --no-report
TELEGRAM_APP_CONFIG=/path/to/accounts-shared-data TELEGRAM_ENV_FILE=/path/to/telegram.env node scripts/mtproxy/api-test.mjs --media
TELEGRAM_APP_CONFIG=/path/to/accounts-shared-data TELEGRAM_ENV_FILE=/path/to/telegram.env node scripts/mtproxy/api-test.mjs --receive-media --chat me --receive-limit 1
TELEGRAM_APP_CONFIG=/path/to/accounts-shared-data TELEGRAM_ENV_FILE=/path/to/telegram.env node scripts/mtproxy/api-test.mjs --receive-profile @telegram
node scripts/mtproxy/api-test.mjs --no-proxy --env-file /path/to/telegram.env
node diagnose-mtproxy.mjs --capture --capture-seconds 20 --api-media --no-report
TELEGRAM_ENV_FILE=/path/to/telegram.env node diagnose-mtproxy.mjs --capture --capture-seconds 30 --api-media --no-report
```

`--receive-media` and `--receive-profile` are receive-only checks. Use
`--relax-ping` only to distinguish an API-client timeout from a dead transfer;
it does not change the proxy. Private values come from `.lenv`,
`TELEGRAM_ENV_FILE`, or CLI paths. Never
commit `.lenv`, `.env`, `.telegram_session`, proxy secrets, API hashes, or SSH
passwords.

## Observed operational issue

During repeated testing the client source IP lost SSH authentication while
ping and TCP 443 still worked, matching the documented source-IP blackhole.
Server diagnostics were therefore run through a temporary outbound-only remote
execution path; no client network was switched. The proxy itself stayed
reachable and served the API checks.

## Repository commits

- `3f58a3d`: import operational tooling.
- `760c758`: add API-based verification and mjs diagnostics.
- `58d5c53`: complete local source import and extend API media checks.
