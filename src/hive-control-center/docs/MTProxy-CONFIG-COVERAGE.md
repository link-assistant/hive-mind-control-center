# MTProxy configuration coverage

Run `scripts/mtproxy/proxy-matrix.mjs` to redeploy and compare these configurations per network; see `MTProxy-MATRIX.md`.

Audited on 2026-11-08 against the classic `mtproxy-classic-443` deployment and
the diagnostics in `scripts/mtproxy/`. Tested results and packet evidence are in
`MTProxy-VERIFICATION.md`; untried ideas are in `MTProxy-RESEARCH-BACKLOG.md`.

Statuses:

- **PASS**: completed and verified.
- **FAIL**: completed the test but did not transfer the intended data.
- **PARTIAL**: observed or configured, but not enough evidence for an end-to-end pass.
- **UNTESTED**: supported by the scripts or a documented option, but not exercised.
- **N/A**: deliberately not used, because it exposes or weakens a secret.

## Deployment and engine options

| Area            | Option/value                                           | Status   | Evidence or note                                                       |
| --------------- | ------------------------------------------------------ | -------- | ---------------------------------------------------------------------- |
| Engine          | classic `mtproto-proxy`                                | PASS     | Text works; media path fails at the network layer.                     |
| Engine          | `mtg` 2.3.0 FakeTLS                                    | FAIL     | Text/media stalled with three fronting hosts; rolled back.             |
| Engine          | `telegrammessenger/proxy:2.0beta`                      | FAIL     | Same ping timeouts; binary version is not the cause.                   |
| Engine          | `mtg simple-run`                                       | FAIL     | dd/hex secret variant stalled.                                         |
| Image           | `mtproxy/mtproxy:latest`                               | PASS     | Current production image; container healthy.                           |
| Image           | newer/latest official MTProxy build                    | UNTESTED | Current image is older than a fresh source build.                      |
| Workers         | 1                                                      | PARTIAL  | Earlier deployment; text path existed.                                 |
| Workers         | 4                                                      | PASS     | Current production; text works during healthy windows.                 |
| Workers         | 2, 3, 5, 6                                             | UNTESTED | 6 workers need about 393k open files.                                  |
| Host port       | 443                                                    | PASS     | TCP reachability and MTProto API text pass.                            |
| Host port       | 8443                                                   | PARTIAL  | MSS rule installed; an mtg test used it, classic did not.              |
| Host port       | 80, 8080                                               | UNTESTED | Alternate-port path not tested.                                        |
| Container port  | 443                                                    | PASS     | Current classic mapping.                                               |
| Port mapping    | `INTERNAL_PORT=443 PORT=8888`                          | FAIL     | No 443 listener; attempt discarded.                                    |
| MSS clamp       | 1200                                                   | PASS     | Applied on 443 and 8443, both directions; capture shows rewritten MSS. |
| MSS clamp       | 1360                                                   | FAIL     | Too high on this path.                                                 |
| MSS clamp       | 1024, 1100, 1300                                       | UNTESTED | Values not exercised.                                                  |
| Secret          | classic `dd` 32-hex                                    | PASS     | Persisted in `/data/secret`; app secret matches.                       |
| Secret          | mtg `ee...` FakeTLS                                    | FAIL     | mtg connected but did not complete transfers.                          |
| Secret          | pinned `MTPROXY_SECRET`                                | UNTESTED | Generated/persisted secrets were used.                                 |
| Fronting host   | `contabo.com`, `www.google.com`, `vk.com`              | FAIL     | All three FakeTLS tries stalled.                                       |
| Fronting host   | other domains                                          | UNTESTED | Not tried.                                                             |
| `proxy.conf`    | known-good default DC map                              | PASS     | 15 known-good checks, 0 mismatches.                                    |
| `proxy.conf`    | alternate DC/media mappings                            | UNTESTED | Only the current mapping was tested.                                   |
| Restart policy  | `unless-stopped`                                       | PASS     | Inspected and verified.                                                |
| Network mode    | bridge                                                 | PASS     | Current production mode.                                               |
| Volume          | `/root/.hive-mtproxy-classic-443:/data`                | PASS     | Secret/config persisted.                                               |
| File limit      | `nofile=524288:524288`                                 | PASS     | Container stable; 65536 crash-looped.                                  |
| TCP MSS service | `mtproxy-mss.service`, ports 443/8443                  | PASS     | Enabled, active, 4 rules.                                              |
| TCP congestion  | BBR                                                    | PARTIAL  | Already active; did not fix the bulk-transfer path.                    |
| TCP options     | timestamps/window scaling disabled                     | FAIL     | No improvement.                                                        |
| TCP buffers     | `tcp_rmem`, `tcp_wmem`, `somaxconn`                    | UNTESTED | Now collected by diagnostics, not tuned or compared.                   |
| Deploy flags    | `--mtproxy`, `--mtproxy-only`, `--mtproxy-update`      | PASS     | Used to install/restart/repair the proxy.                              |
| Deploy flags    | `--verify-mtproxy`                                     | PASS     | Used by the classic deployment path.                                   |
| Deploy flags    | `--mtproxy-engine`, `--mtproxy-image`                  | PASS     | Classic and mtg engines exercised.                                     |
| Deploy flags    | `--mtproxy-classic-image`                              | UNTESTED | Default image used; alternate tag not exercised.                       |
| Deploy flags    | `--mtproxy-workers`, `--mtproxy-port`, `--mtproxy-mss` | PASS     | Current values deployed and verified.                                  |
| Deploy flags    | `--mtproxy-fronting-host`                              | PASS     | Three hosts exercised with mtg.                                        |
| Deploy flags    | `--mtproxy-undeploy`, `--mtproxy-undeploy-temporary`   | UNTESTED | Added for safe runtime removal; not yet run against the production proxy. |
| Deploy flags    | `--dangerously-show-secrets`                           | N/A      | Deliberately avoided; secrets stay root-only.                          |
| Deploy flags    | `--reset-docker` / unrelated hive-mind changes         | N/A      | Out of scope for MTProxy research.                                     |

## Client and API options

| Area            | Option/value                                     | Status   | Evidence or note                                                         |
| --------------- | ------------------------------------------------ | -------- | ------------------------------------------------------------------------ |
| Client app      | macOS Telegram with classic `dd`                 | PARTIAL  | Text works; photos/media stall.                                          |
| Client app      | macOS Telegram with FakeTLS/TLS tunnel           | UNTESTED | Real app not tested through a FakeTLS or TLS tunnel.                     |
| Client app      | Telegram Desktop                                 | UNTESTED | Only the macOS app was observed.                                         |
| API client      | `teleproto` text marker                          | PASS     | Marker sent, read back, cleaned; periodic timeouts remain.               |
| API client      | `--media` document                               | FAIL     | Earlier small document passed; current path times out.                   |
| API client      | `--receive-media --chat me`                      | PARTIAL  | Limits 1/2/5 returned without a photo; limit 3 hung; no photo available. |
| API client      | `--receive-media --chat @telegram`               | FAIL     | Limit 1 hung.                                                            |
| API client      | `--receive-profile @telegram`                    | FAIL     | Profile photo download timed out.                                        |
| API client      | `--roundtrip-photo`                              | FAIL     | `photo upload timed out after 30000ms`; local PNG tests pass.            |
| API timeout     | default 5-second teleproto ping                  | FAIL     | `Ping timeout of 5.0s expired` during media.                             |
| API timeout     | `--relax-ping` (60 seconds)                      | FAIL     | Media still did not complete.                                            |
| API transport   | `--no-proxy`                                     | FAIL     | Direct Telegram path also timed out.                                     |
| API secret      | `--secret`, `--secret-file`, app config          | PARTIAL  | Secret and app config used; `--secret-file` not explicitly exercised.    |
| API credentials | `TELEGRAM_API_ID/HASH`, session file             | PASS     | API text path used them.                                                 |
| API messages    | `--keep`                                         | UNTESTED | Marker cleanup path was used instead.                                    |
| Photo options   | size/default, tolerance/default, timeout/default | PARTIAL  | Defaults used by the live roundtrip; fixed color not used.               |
| Bot API         | client network                                   | FAIL     | `api.telegram.org` timed out.                                            |
| Bot API         | server network                                   | FAIL     | Token returned `404 Not Found`.                                          |
| Chat targets    | Saved Messages, `@telegram`, profile             | PARTIAL  | Saved Messages text works; photo receive/profile paths fail.             |

## Diagnostic options

| Option                                      | Status   | Note                                                            |
| ------------------------------------------- | -------- | --------------------------------------------------------------- |
| `--port`, `--container`                     | PASS     | Used against `mtproxy-classic-443`.                             |
| `--capture`                                 | PASS     | Server pcap analyzed.                                           |
| `--capture-seconds`                         | PASS     | 20- and 80-second captures used.                                |
| `--client-capture`                          | UNTESTED | New two-sided capture; needs passwordless `sudo tcpdump`.       |
| `--client-interface`                        | UNTESTED | Auto-detected interface is implemented, not exercised.          |
| `--client-ip`                               | PASS     | Used to restrict server pcap analysis.                          |
| `--keep-pcap`                               | UNTESTED | Temporary captures were deleted.                                |
| `--restart-telegram`                        | PASS     | Used to generate fresh app connections.                         |
| `--strict`                                  | UNTESTED | Non-strict diagnostics used.                                    |
| `--no-report`                               | PASS     | Used for quick runs.                                            |
| `--media-seconds`                           | PASS     | Partial-media sampling used.                                    |
| `--report-dir`                              | PASS     | Default timestamped report directory used.                      |
| `--compare`                                 | UNTESTED | New summary JSON comparison; no live pair captured yet.         |
| `--lenv`, `--known-good`, `--no-known-good` | PARTIAL  | Defaults used; explicit alternate profile not.                  |
| `--api-test`                                | PASS     | Text marker exercised.                                          |
| `--api-media`                               | FAIL     | Document/photo media path exercised and failed.                 |
| `--api-roundtrip-photo`                     | UNTESTED | Implemented in diagnostics; direct `api-test` roundtrip failed. |
| `--api-photo-size/color/tolerance/timeout`  | PARTIAL  | Defaults used; fixed color not.                                 |
| `--api-relax-ping`                          | FAIL     | Implemented and tested through `api-test`; media still failed.  |
| `--api-keep`                                | UNTESTED | Cleanup used instead.                                           |
| `--api-receive-limit`                       | PASS     | 1, 2, 3, and 5 exercised.                                       |
| `--api-receive-profile/media`               | FAIL     | Receive-only paths timed out.                                   |
| `--api-media` + `--capture`                 | PASS     | Generated traffic that the server pcap analyzed.                |
| `--client-capture` + `--api-test`           | UNTESTED | Requires passwordless sudo and a fresh live run.                |

## Environment variable aliases

Every environment variable read by the MTProxy scripts is listed here. The
`MTPROXY_*` deployment names are aliases for the corresponding CLI flags.

| Variable                       | Used by                  | Status/note                                 |
| ------------------------------ | ------------------------ | ------------------------------------------- |
| `LENV_FILE`                    | diagnostics              | PASS, default `.lenv` used.                 |
| `MTPROXY_HOST`                 | API test                 | PASS, resolved from `.lenv`/CLI.            |
| `MTPROXY_PORT`                 | deploy, diagnostics, API | PASS, 443 used.                             |
| `MTPROXY_SECRET_KEY`           | API test                 | PASS, read from container secret.           |
| `MTPROXY_SECRET_FILE`          | API test                 | UNTESTED, secret passed directly.           |
| `MTPROXY_LENV_FILE`            | API test                 | PASS, `.lenv` path supplied.                |
| `MTPROXY_API_MEDIA`            | API test                 | FAIL, media path stalled.                   |
| `MTPROXY_API_RECEIVE_MEDIA`    | API test                 | PARTIAL, no photo found; some limits hung.  |
| `MTPROXY_API_RECEIVE_PROFILE`  | API test                 | FAIL, profile download timed out.           |
| `MTPROXY_API_ROUNDTRIP_PHOTO`  | API test                 | FAIL, photo upload timed out.               |
| `MTPROXY_API_PHOTO_SIZE`       | API test, diagnostics    | PARTIAL, default 128 used.                  |
| `MTPROXY_API_PHOTO_COLOR`      | API test, diagnostics    | UNTESTED, random color used.                |
| `MTPROXY_API_PHOTO_TOLERANCE`  | API test, diagnostics    | PARTIAL, default 8 used.                    |
| `MTPROXY_API_PHOTO_TIMEOUT_MS` | API test, diagnostics    | PARTIAL, default used.                      |
| `MTPROXY_API_TIMEOUT_MS`       | API test, diagnostics    | PASS, caps whole API test.                  |
| `MTPROXY_API_CHAT`             | API test                 | PARTIAL, `me` and `@telegram` used.         |
| `MTPROXY_API_RECEIVE_LIMIT`    | API test, diagnostics    | PASS, 1/2/3/5 used.                         |
| `MTPROXY_API_RELAX_PING`       | API test, diagnostics    | FAIL, media still timed out.                |
| `MTPROXY_CONTAINER`            | diagnostics              | PASS, `mtproxy-classic-443`.                |
| `MTPROXY_CAPTURE_SECONDS`      | diagnostics              | PASS, 20/80 seconds.                        |
| `MTPROXY_CLIENT_IFACE`         | diagnostics              | UNTESTED, auto-detected route.              |
| `MTPROXY_CLIENT_IP`            | diagnostics              | PASS, server pcap filter.                   |
| `MTPROXY_COMPARE_FILE`         | diagnostics              | UNTESTED, new comparison mode.              |
| `MTPROXY_KNOWN_GOOD`           | diagnostics              | PASS, default profile.                      |
| `MTPROXY_SSH_TIMEOUT_MS`       | diagnostics              | PASS, blocks unreachable-server runs.       |
| `MTPROXY_MEDIA_SECONDS`        | diagnostics              | PASS, partial-media sample.                 |
| `MTPROXY_REPORT_DIR`           | diagnostics              | PASS, default report directory.             |
| `MTPROXY_RUN_ID`               | diagnostics              | UNTESTED, generated stamp used.             |
| `TELEGRAM_ENV_FILE`            | diagnostics, API test    | PASS, API credentials loaded.               |
| `TELEGRAM_SESSION_FILE`        | diagnostics, API test    | PASS, session loaded.                       |
| `TELEGRAM_APP_CONFIG`          | API test                 | UNTESTED, direct secret/env used.           |
| `TELEGRAM_API_ID`              | API test                 | PASS, read from credentials file.           |
| `TELEGRAM_API_HASH`            | API test                 | PASS, read from credentials file.           |
| `SERVER_IP`                    | deploy, diagnostics, API | PASS, current server.                       |
| `DEPLOY_MTPROXY`               | deploy                   | PASS, deployment enabled.                   |
| `VERIFY_MTPROXY`               | deploy                   | PASS, verification enabled.                 |
| `MTPROXY_ONLY`                 | deploy                   | PASS, used for proxy-only deploys.          |
| `MTPROXY_UPDATE`               | deploy                   | PASS, used to recreate the proxy.           |
| `MTPROXY_ENGINE`               | deploy                   | PASS, classic and mtg.                      |
| `MTPROXY_IMAGE`                | deploy                   | PASS, mtg 2.3.0 tested.                     |
| `MTPROXY_CLASSIC_IMAGE`        | deploy                   | UNTESTED, default official image used.      |
| `MTPROXY_WORKERS`              | deploy                   | PASS, 1/4 used; 2/3/5/6 untested.           |
| `MTPROXY_MSS`                  | deploy                   | PASS, 1200; 1360 too high; others untested. |
| `MTPROXY_FRONTING_HOST`        | deploy                   | FAIL, three hosts tried with mtg.           |
| `MTPROXY_SECRET`               | deploy                   | UNTESTED, secrets generated/persisted.      |

## Network and path options

| Area       | Option/value                           | Status   | Evidence or note                                                              |
| ---------- | -------------------------------------- | -------- | ----------------------------------------------------------------------------- |
| Path       | direct Cloudflare 1 MB                 | PASS     | Completed in about 0.5 s, proving the client has working downstream capacity. |
| Path       | direct server HTTP 8000/8001           | FAIL     | Stalled after about 9-11 KB.                                                  |
| Path       | gost TLS 8443/80                       | FAIL     | Same bulk stall.                                                              |
| Path       | gost SOCKS5 1080                       | FAIL     | Same bulk stall.                                                              |
| Path       | cloudflared quick tunnel               | FAIL     | Same bulk stall.                                                              |
| Path       | iperf3 TCP                             | FAIL     | Could not complete.                                                           |
| Path       | IPv4 PMTU 1500 / payload 1472          | PASS     | Path MTU is healthy.                                                          |
| Path       | IPv6                                   | UNTESTED | No routed IPv6 prefix tested.                                                 |
| Relay      | WARP, Tailscale, WireGuard, SSH SOCKS  | UNTESTED | Same-Wi-Fi relay paths not tried.                                             |
| Transport  | QUIC/hysteria2/WebSocket tunnel        | UNTESTED | Loss-resilient transports not tried.                                          |
| Media path | CDN vs non-CDN, parallel/chunked media | UNTESTED | Not isolated in the client.                                                   |
| Source IP  | repeated SSH from same client IP       | FAIL     | Documented blackhole behavior; test runs can block SSH.                       |

## Coverage gaps to close

1. Run `--client-capture` with `--capture` and a text/photo action, then compare
   client-sent and server-received bytes plus retransmits.
2. Run `--compare` against the previous summary JSON.
3. Test the real macOS and Desktop clients through a FakeTLS/TLS tunnel.
4. Test same-Wi-Fi relays and a loss-resilient transport.
5. Exercise workers 2/3/5/6, MSS 1024/1100/1300, and alternate ports/IPv6.
6. Test pinned secrets, alternate `proxy.conf` DC maps, and `--secret-file`.
7. Test the latest official MTProxy build and mtg versions after 2.3.0.
8. Test real incoming photo, non-CDN/parallel media, and `--keep`.

This file is the option inventory, not a claim that every possible environment
combination has been exercised. Any new option or environment variable must be
added here with a status and evidence.
