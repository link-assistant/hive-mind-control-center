# MTProxy verification evidence

Verified on 2026-11-08 against `161.97.177.66:443` with the classic
`mtproxy-classic-443` container.

## Results

| Check                        | Result                                                              |
| ---------------------------- | ------------------------------------------------------------------- |
| Known-good profile           | PASS, 15 checks, 0 mismatches                                       |
| Telegram app proxy           | match, `dd` prefix, app secret matches `/data/secret`               |
| Text through MTProto API     | PASS, `user=@drakonard`, marker read back and deleted               |
| Document through MTProto API | PASS, 68 bytes uploaded, downloaded, SHA-256 matched, deleted       |
| Photo through MTProto API    | NOT VERIFIED, check added; latest run timed out before transfer     |
| Bidirectional packet capture | PASS, client 8262 bytes, proxy 11901 bytes, 2 client connections    |
| Path MTU                     | PASS, 1500-byte MTU / 1472-byte payload                             |
| TCPMSS                       | 1200 on ports 443 and 8443, both directions, service enabled/active |
| New app transport errors     | none during the run                                                 |
| Idle client connections      | 994 established; 842 inbound clients, 144 outbound DC sockets       |
| Container file limit         | explicit `nofile=524288:524288`; engine needs 65552                 |

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

### Network path findings

The media failure is not specific to MTProxy. On the current client network,
small responses complete but bulk TCP transfers to this server stall after
roughly 9-11 KB:

| Test                                                  | Result                                  |
| ----------------------------------------------------- | --------------------------------------- |
| `ping -D -s 1472` to server                           | 0% loss, so the path MTU is 1500        |
| Direct `http://SERVER:8000/1mb.bin`                   | `200`, 9,504-11,200 bytes, then timeout |
| Direct host `http://SERVER:8001/1mb.bin` (not Docker) | `200`, 11,200 bytes, then timeout       |
| `iperf3 -p 5201`                                      | 0 bytes/sec in both directions          |
| gost TLS tunnel on 8443 or 80, local SOCKS5           | small HTTP `200`; 1 MB and HTTPS stall  |
| gost plain SOCKS5 tunnel on 1080                      | same stall                              |
| cloudflared quick tunnel to host HTTP                 | `200`, 1,369 bytes, then stall          |
| Direct Cloudflare 1 MB download                       | `200`, 1,000,000 bytes in ~0.5 s        |

MSS clamping to 1200, disabling timestamps/window scaling, and BBR did not
change the result. The current client network therefore throttles or blackholes
bulk TCP to this server after the first few packets, while text-sized requests
pass. MTProxy configuration cannot repair that path; a relay or tunnel whose
bulk path is not throttled is required.

### Packet-capture evidence (2026-11-08)

A server-side `tcpdump -i any -nn -s0 -w /tmp/mtpcap.pcap 'tcp port 443'`
capture ran for 80 seconds while the client ran a text check followed by
`--roundtrip-photo`. The capture includes every client port-443 flow during that
window, not only the API test. It was filtered to `eth0` so Docker's
`veth`/`docker0` duplicate frames were not counted. The client source address
is omitted here.

| Direction                           | Packets |  Bytes |
| ----------------------------------- | ------: | -----: |
| server `eth0` out (proxy -> client) |     129 | 48,218 |
| server `eth0` in (client -> proxy)  |     109 |  8,671 |

TCP flags included 29 SYNs. Eleven distinct server sequence ranges were sent
more than once, producing 40 extra retransmitted segments. Examples:

| Client port | Server sequence end | Highest client ACK | Repeated server segment                    |
| ----------- | ------------------: | -----------------: | ------------------------------------------ |
| 40298       |               3,207 |                771 | `seq 771:1530`, 759 bytes, sent 3 times    |
| 45620       |               5,816 |              4,451 | `seq 4451:5559`, 1,108 bytes, sent 7 times |
| 42525       |               5,275 |              3,637 | `seq 3637:3751`, 114 bytes, sent 8 times   |
| 33334       |               3,172 |              3,063 | `seq 3063:3172`, 109 bytes, sent 9 times   |

The client log for the same interval contained repeated
`Connection to dc 2 closed (lost: Error: Ping timeout of 5.0s expired)` and the
photo check ended with `API_TEST_ERROR=photo upload timed out after 30000ms`.
The text check also failed during this particular capture; it had passed in
earlier runs. Server and client observations therefore do **not** match: the
server keeps sending and retransmitting while the client ACKs only part of the
stream, then gives up. This locates the loss on the server-to-client network
leg, not inside MTProxy.

The upload path is also affected, but the capture shows the client only sent
8.7 KB while the server sent 48.2 KB. The immediate failure is that the client
cannot receive/ACK the server's response and data; a client-side capture was not
possible because local `tcpdump` needs sudo, so upload-payload loss could not be
separated from response loss. After the capture, a fresh text check reached
`API_TEST_SENT=yes` and `API_TEST_CLEANED=yes`, confirming the proxy recovers
when the path improves. The pcap was analyzed on the server and deleted; it is
not stored in this repository.

Current status: messages work, media upload/download does not complete from this
client network. This is not a passing photo/media verification.

## Configuration matrix (tested 2026-11-08)

All rows were tested from the same client network; no network switch was used.
"Connect" means the client reached DC2 or the proxy but did not complete a
request; "text" means the Saved Messages marker was sent, read back, and deleted.

| #   | Proxy / image                               | Transport and port            | Workers, limits    | Secret / fronting             | Result                                                                                            |
| --- | ------------------------------------------- | ----------------------------- | ------------------ | ----------------------------- | ------------------------------------------------------------------------------------------------- |
| 1   | classic `mtproxy/mtproxy:latest` (2019)     | HTTP `-H 443`, app port 443   | 1, `nofile=65536`  | `dd` key                      | Startup failed: `cannot raise open file limit to 65552`                                           |
| 2   | classic 2019                                | HTTP `-H 443`, app port 443   | 1, `nofile=524288` | `dd` key                      | Text PASS; media upload FAIL (ping timeouts)                                                      |
| 3   | classic 2019                                | HTTP `-H 443`, app port 443   | 4, `nofile=524288` | `dd` key                      | Text PASS immediately; media upload, `@telegram` receive, and profile-photo download FAIL         |
| 4   | classic 2019                                | `INTERNAL_PORT=443 PORT=8888` | 1, `nofile=524288` | `dd` key                      | No listener on 443 (only 8888); discarded                                                         |
| 5   | `telegrammessenger/proxy:2.0beta` (2026-04) | HTTP `-H 443`, host 8443      | default            | same `dd` key                 | Connects; media FAIL, same ping timeouts                                                          |
| 6   | mtg 2.3.0 FakeTLS                           | TLS/443                       | default            | `ee` secret, `contabo.com`    | Connects; text FAIL                                                                               |
| 7   | mtg 2.3.0 FakeTLS                           | TLS/443                       | default            | `ee` secret, `www.google.com` | Connects; text FAIL                                                                               |
| 8   | mtg 2.3.0 FakeTLS                           | TLS/443                       | default            | `ee` secret, `vk.com`         | Connects; text FAIL                                                                               |
| 9   | mtg 2.3.0 `simple-run`                      | plain MTProto/443             | default            | raw `dd<key>` or 32-hex key   | Startup rejected: incorrect first secret byte                                                     |
| 10  | direct (no proxy)                           | Telegram DC 443               | n/a                | n/a                           | Text/media requests time out from this client                                                     |
| 11  | classic 2019                                | receive-only API              | 4, `nofile=524288` | `dd` key                      | `getMessages('me',limit:1)` completes (no photo); `@telegram` history and profile photos time out |

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
TELEGRAM_APP_CONFIG=/path/to/accounts-shared-data TELEGRAM_ENV_FILE=/path/to/telegram.env node scripts/mtproxy/api-test.mjs --roundtrip-photo --photo-size 128
node scripts/mtproxy/api-test.mjs --no-proxy --env-file /path/to/telegram.env
node diagnose-mtproxy.mjs --capture --capture-seconds 20 --api-media --no-report
TELEGRAM_ENV_FILE=/path/to/telegram.env node diagnose-mtproxy.mjs --capture --capture-seconds 30 --api-media --no-report
```

`--receive-media` and `--receive-profile` are receive-only checks.
`--roundtrip-photo` generates a random solid-color PNG, sends it to Saved
Messages as a photo, downloads it, and verifies the dimensions and center color;
it prints `exact=yes` when Telegram preserved the PNG bytes, otherwise the
`delta` must stay within `--photo-tolerance`. JPEG downloads are decoded with
macOS `sips`. Use `--relax-ping` only to distinguish an API-client timeout from
a dead transfer; it does not change the proxy. Private values come from `.lenv`,
`TELEGRAM_ENV_FILE`, or CLI paths. Never
commit `.lenv`, `.env`, `.telegram_session`, proxy secrets, API hashes, or SSH
passwords.

## Observed operational issue

During repeated testing the client source IP lost SSH authentication while
ping and TCP 443 still worked, matching the documented source-IP blackhole.
Server diagnostics were therefore run through a temporary outbound-only remote
execution path; no client network was switched. The proxy itself stayed
reachable and served the API checks.

## Repository audit (2026-11-08)

The GitHub source of truth is the nested clone at
`/Users/konard/Code/Archive/link-assistant/hive-control-center/repository`,
remote `https://github.com/link-assistant/hive-mind-control-center.git`, branch
`main`. At audit time it was clean and tracking `origin/main`; the last
verification commit was `31d7f3b`.

All active source and logic under
`repository/src/hive-control-center` is tracked and pushed, including
`deploy-docker.mjs`, `diagnose-mtproxy.mjs`, `scripts/mtproxy/api-test.mjs`,
`scripts/mtproxy/solid-photo.mjs`, the diagnostics modules, docs, and tests.

The parent workspace is an older duplicate checkout with its own local git
repository. Its active source files have the same content as the nested source
of truth, except `deploy-docker.mjs`, `docs/DEPLOY.md`,
`docs/workspace-permissions-research.md`, and
`scripts/mtproxy/known-good.json`, which are older in the parent. The parent
copies of `diagnose-mtproxy.sh` and `update-docker.sh` are retired; their `.mjs`
replacements are in the nested repository. Parent `auto-fix` source files match
the nested repository; its only content difference is an extra trailing newline
in `auto-fix/issue-footer.md`. The parent repository has no remote and is not
the GitHub source of truth.

Private or generated data is deliberately excluded: `.lenv`, `.env`,
`.telegram_session`, `data/`, `case-data/`, logs, pcap files, reports,
`node_modules/`, and `__pycache__/`.

## Repository commits

- `3f58a3d`: import operational tooling.
- `760c758`: add API-based verification and mjs diagnostics.
- `58d5c53`: complete local source import and extend API media checks.
