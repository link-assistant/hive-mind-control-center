# Hive Mind deploy notes

`deploy-remote-docker.mjs` deploys `deploy-docker.mjs` to the server
defined in `.lenv` (`SERVER_IP`, `SERVER_USER`, `SERVER_PASS`) and runs it
there. The local script supports both hive-mind image variants and several
cleanup modes.

## Image variants

The deploy supports two hive-mind images, selected with `--image-variant`:

| Variant | Image | When to use |
| --- | --- | --- |
| `dind` (default) | `konard/hive-mind-dind:latest` | Bot needs a nested Docker daemon (e.g. `start-command --isolation docker`, testcontainers, CI emulation). Requires `--privileged` on `docker run`, handled by the script. |
| `plain` | `konard/hive-mind:latest` | No nested Docker needed. Slightly lower attack surface (no `--privileged`). |

Default variant is `dind` (the upstream limitations that blocked it,
[link-foundation/box#88](https://github.com/link-foundation/box/issues/88) and
[link-assistant/hive-mind#1850](https://github.com/link-assistant/hive-mind/issues/1850),
both shipped).

Set via flag (`--image-variant plain`) or env (`HIVE_MIND_IMAGE_VARIANT=plain`).

## Telegram MTProto proxy (`--mtproxy`)

Telegram can be blocked on some networks. The deploy can run an MTProto proxy
next to hive-mind. The **default and supported engine is the classic official
`mtproxy/mtproxy` image** (`mtproto-proxy`), because it is the only engine that
has passed the real end-to-end test on this host:

- messages both ways;
- photo thumbnails and full photos;
- video playback / multi-MB downloads;
- large documents up to at least 22 MB;
- reconnect after proxy restart and host reboot.

`nineseconds/mtg` remains selectable with `--mtproxy-engine mtg` for
experiments, but it is **not** the default. Its FakeTLS ClientHello repeatedly
stalled on this mobile path (1534-byte ClientHello, only 1188 bytes reaching the
server, client Send-Q stuck at 1534, media DCs timing out).

```bash
# Deploy hive-mind plus/update the classic MTProto proxy
./deploy-remote-docker.mjs --mtproxy

# Safe append-only path: add or verify the proxy without touching hive-mind
./deploy-remote-docker.mjs --mtproxy-only --verify-mtproxy
```

The proxy is **off by default**. It can also be enabled persistently in `.lenv`
with `DEPLOY_MTPROXY: true`. Its settings live in `.lenv` (copied to the
server), so the secret never has to travel on a command line:

| Key | Default | Meaning |
| --- | --- | --- |
| `MTPROXY_ENGINE` | `classic` | `classic` (supported) or `mtg` (experimental FakeTLS). |
| `MTPROXY_PORT` | `443` | Host port to publish; the container always listens on `443`. Classic container name is `mtproxy-classic-<port>`. |
| `MTPROXY_MSS` | `1200` | TCP MSS clamp applied in both directions. `1360` was too high on the mobile path. |
| `MTPROXY_CLASSIC_IMAGE` | `mtproxy/mtproxy:latest` | Classic engine image. |
| `MTPROXY_SECRET` | unset | Optional 32-char hex key (an mtg `ee...` secret is accepted and its key reused). Unset reuses the persisted key or generates one. |
| `MTPROXY_IMAGE` | `nineseconds/mtg:2.3.0` | mtg-only image override. |

### Why the MSS clamp is required

The proxy runs in a Docker bridge, so the host's public interface and the
container's `veth` negotiate different MSS values. Without a clamp the client can
advertise `mss 1390` and the proxy can emit full-size segments that never reach
the mobile client; messages may work while photos/video stall.

The deploy writes `/usr/local/sbin/mtproxy-mss.sh` and
`/etc/systemd/system/mtproxy-mss.service`, then enables and starts the unit. It
adds both directions for the proxy port(s):

```bash
iptables -t mangle -A FORWARD -p tcp --sport 443 --tcp-flags SYN,RST SYN -j TCPMSS --set-mss 1200
iptables -t mangle -A FORWARD -p tcp --dport 443 --tcp-flags SYN,RST SYN -j TCPMSS --set-mss 1200
```

The rules are idempotent (`-C` before `-A`) and survive reboot via systemd.
Verify them on the server:

```bash
systemctl is-enabled mtproxy-mss.service
systemctl is-active mtproxy-mss.service
iptables -t mangle -S FORWARD | grep TCPMSS
```

Docker caveat: the client SYN may still show the original MSS on the public
interface; the rewrite happens on `docker0`/`veth`. Host `ss` hides container
sockets; inspect inside the container network namespace if needed.

### Persistence and known-good state

The secret is persisted root-only in
`/root/.hive-mtproxy-classic-<port>/secret`; the container mounts that directory
as `/data`. The generated `tg://` link is written root-only to
`/root/.hive-mtproxy-classic-<port>/link.txt` and is not printed into the deploy
log unless `--dangerously-show-secrets` is used:

```bash
ssh root@SERVER_IP 'cat /root/.hive-mtproxy-classic-443/link.txt'
```

A known-good snapshot of the working classic setup (config, secret, inspect,
MSS unit, hashes) is kept at
`/root/mtproxy-known-good-20261107-0740/` on the server. Do not delete it.

The final disk-reclaim step keeps the selected proxy image/container, and
`--verify-reboot` proves the proxy container and MSS unit come back after a
reboot when `--mtproxy` is set.

Note: `--reset-docker` removes every container and image but **not** the
host-side `/root/.hive-mtproxy-classic-<port>/` directory or the MSS files, so the
secret and link survive a Docker reset unless you delete that directory.

### Adding, verifying, or updating the proxy on a running server

Use the safe, append-only mode when hive-mind is already deployed and must keep
running undisturbed:

```bash
./deploy-remote-docker.mjs --mtproxy-only --verify-mtproxy
```

This mode deliberately **skips** the pre-deploy reboot, OS/readiness gates,
swap/BBR and Docker/Node provisioning, AI-session backup, server-side bucket
cleanup, orphan killing, deploy-file copy, and the entire hive-mind
pull/remove/run/cleanup sequence. It only:

1. aborts if another `deploy-docker.mjs` is already running (it never kills it);
2. requires Docker and Node.js/npm to be already installed (it never installs
   or starts them);
3. leaves an already-running proxy exactly as-is (idempotent no-op);
4. starts an existing stopped proxy without recreating it;
5. creates the proxy only if it is missing.

Add `--mtproxy-update` to explicitly recreate **only** the proxy container
(e.g. to repair missing MSS rules, switch images, or apply a changed secret). It
never touches hive-mind:

```bash
# Recreate the classic proxy and verify port + MSS + DC reachability
./deploy-remote-docker.mjs --mtproxy-only --mtproxy-update --verify-mtproxy
```

`--mtproxy-only` implies `--mtproxy` and cannot be combined with
`--reset-docker`, `--verify-reboot`, `--prepare`, `--backup-only`, or
`--clean-temp-archives`.

### Verification

Classic verification checks:

- container is running with `--restart unless-stopped`;
- logs contain no fatal startup error;
- host port is listening;
- `mtproxy-mss.service` is enabled/active and both MSS directions are present;
- the server can reach Telegram DCs `149.154.161.144:8888`,
  `149.154.161.184:8888`, and media DC `91.105.192.110:443`.

For local/remote diagnostics use:

```bash
./diagnose-mtproxy.mjs
```

It defaults to the classic container `mtproxy-classic-443` and auto-falls back
to `mtproxy` when needed. It collects the app proxy config/secret hash, app log
errors, media progress, server sockets, TCP/DC2-main text-path state, MSS rules,
and writes a timestamped report under `data/diagnostics/`.

For a hands-off end-to-end text/media check, restart Telegram automatically and
capture packets:

```bash
./diagnose-mtproxy.mjs --capture --restart-telegram --capture-seconds 20
```

For a protocol-level text check that does not touch the visual app:

```bash
TELEGRAM_ENV_FILE=/path/to/telegram.env ./diagnose-mtproxy.mjs --api-test --no-report
TELEGRAM_ENV_FILE=/path/to/telegram.env ./diagnose-mtproxy.mjs --api-media --no-report
```

The API test sends a unique marker to Saved Messages, reads it back, and
deletes it. `--api-media` also uploads a tiny document, downloads it again,
and compares SHA-256 before deleting both messages. Use `--telegram-session` when the session file is not next to the
environment file.

The analyzer reports `CAPTURE_CLIENT_BYTES` and `CAPTURE_PROXY_BYTES`. If
`CAPTURE_CLIENT_BYTES=0` the TCP handshake works but client payload is not
arriving (path/DPI). If payload arrives but `CAPTURE_PROXY_BYTES=0`, the proxy
or Telegram upstream is stalled. A bidirectional capture plus
`dc2_main_active > 0` means the text path is healthy.

Diagnostics are implemented without Python:

- `scripts/mtproxy/app-config.mjs` parses the Telegram app proxy config and
  compares a SHA-256 of the key, without printing the secret;
- `scripts/mtproxy/ss-tin.mjs` summarizes client-side socket payload/queues;
- `scripts/mtproxy/pcap.mjs` streams the remote pcap through stdin and reports
  handshake/payload direction, MSS, and a verdict.

Use `--strict` in automation to exit non-zero on hard failures. The app log
delta is measured from the start of the run, so historical `no response` lines
do not cause false failures.

The client link must use the `dd` prefix for the classic engine:

```text
tg://proxy?server=SERVER_IP&port=443&secret=dd<32-hex-key>
```

If the macOS Telegram client already has an old `mtg`/`ee...` link, replace it
with the classic link. The app config lives at
`~/Library/Group Containers/6N38VWS5BX.ru.keepcoder.Telegram/appstore/accounts-shared-data`.

Known operational recovery:

- A client source IP can become blackholed. Symptom: SSH auth hangs and
  Telegram payload stalls even though ping/TCP connect works. Switch Wi-Fi or
  mobile network; a new source IP usually restores it.
- After a network change, Telegram can keep stale transport state and log
  `dc2 ... no response for 20/40/80 s, invalidating the transport scheme`.
  `./diagnose-mtproxy.mjs --capture --restart-telegram` clears it and proves the
  fresh path with a bidirectional packet capture.
- A known-good snapshot of the working classic setup is stored root-only at
  `/root/mtproxy-known-good-20261107-0740/`; keep it for rollback/reference.

## Cleanup behavior

The script aims to keep disk usage tight without surprising the operator.
There are three cleanup modes, in increasing order of aggressiveness:

### 1. Default — clean the active deploy state

Always performed:

- Stop and remove the running `hive-mind` container.
- Remove the previous committed image `hive-mind-configured:latest`.
- `docker image prune -f && docker system prune -f` (removes dangling images
  and the standard system junk; does NOT touch named images or volumes).

### 2. Default — remove the *inactive* hive-mind variant

When you switch variants (e.g. plain → dind, or dind → plain), the previously
pulled variant's image (typically ~26 GB) is dead weight. The script removes
every tag of the inactive variant's repository (`konard/hive-mind` or
`konard/hive-mind-dind`) so disk stays bounded.

Opt out with `--keep-inactive-variant` (e.g. if you switch variants frequently
and want to skip the re-pull next time at the cost of disk).

### 3. `--reset-docker` — full nuke

`./deploy-remote-docker.mjs --reset-docker` (forwards `--reset-docker` to the
remote script) wipes every Docker object on the host before deploying:

- Stops and removes ALL containers (including unrelated ones).
- Removes ALL images.
- Removes ALL volumes.
- Removes ALL networks.
- Clears the buildx/builder cache.

Use this when:

- The host has accumulated cruft from manual experiments and `docker system df`
  shows large reclaimable space.
- The committed image's filesystem looks corrupt and you want to start over.
- You're handing the host off and want it back to a clean Docker state.

Do NOT use this when:

- The host runs other Docker workloads alongside hive-mind. `--reset-docker`
  is host-wide; it will kill them too.

This flag prints `WARNING: stopping ALL containers, removing ALL images...`
before doing anything destructive. Run with `--verbose` to see each command.

## Examples

```bash
# Default deploy (dind variant, removes inactive plain image automatically)
./deploy-remote-docker.mjs

# Deploy the plain image instead (removes inactive dind image automatically)
./deploy-remote-docker.mjs --image-variant plain

# Deploy dind and keep the plain image around (faster swap-back, more disk)
./deploy-remote-docker.mjs --image-variant dind --keep-inactive-variant

# Full host-wide Docker reset before deploying, then deploy dind
./deploy-remote-docker.mjs --reset-docker

# Reset + plain
./deploy-remote-docker.mjs --reset-docker --image-variant plain

# Override the image entirely (e.g. pin to a specific tag)
./deploy-remote-docker.mjs --image konard/hive-mind-dind:1.74.3

# Also deploy/update the Telegram MTProto proxy (settings from .lenv)
./deploy-remote-docker.mjs --mtproxy --verify-mtproxy

# Add ONLY the proxy to an already-running server (no reboot/restart/cleanup)
./deploy-remote-docker.mjs --mtproxy-only

# Explicitly recreate ONLY the proxy (switch image/config) and verify it
./deploy-remote-docker.mjs --mtproxy-only --mtproxy-update --verify-mtproxy
```

## Preparing a deploy in advance (`--prepare`)

```bash
./deploy-remote-docker.mjs --prepare   # any time, as often as you like
./deploy-remote-docker.mjs             # later: the real deploy, now fast
```

`--prepare` does the slow, download-heavy parts while the current deployment keeps running:

- syncs the AI sessions (`claude`, `codex`, `claude.json`) into `data/backups/mirror/`;
- pre-pulls the hive-mind image on the server (skipped with less than 35 GB free). The running container keeps its own image.

It never reboots, provisions swap, stops or removes a container, or empties server buckets (the cleanup runs as a dry run, so you see what the real deploy will reclaim). Leftover temp archives are listed, not deleted. Its output goes to `deploy-remote-docker.prepare.log`, so it does not truncate the log of a deploy that is still running.

## Transfer speed to the server

Measured 2026-10-23 during a deploy: the mirror rsync ran at ~35 KB/s. The server sends with loss-based cubic over a ~300 ms path with ~3% packet loss. Its TCP window collapsed to 9 segments, and 4.9% of the bytes were retransmitted. That caps one stream at about MSS/RTT × 1.22/√loss ≈ 32 KB/s. The server was idle and the local rsync used 0.1% CPU. What the script does about it:

- `--tcp-bbr` (default on): loads `tcp_bbr` and makes BBR the server's default congestion control, persistently. It only affects new connections. Use `--no-tcp-bbr` to skip it.
- `--rsync-compress zstd` (default): zstd stream compression inside rsync. Session JSONL measured 6.1× smaller (claude) and 3.6× (codex). No archive files are created. Use `off` to disable it.
- Delta transfer: `--whole-file` was removed, so growing session files send only their new tail.

## Direct `deploy-docker.mjs` invocation

If you're already on the server, run the local script directly with the same
flags. It accepts everything the deploy script accepts (minus the SSH flags):

```bash
# On the server:
cd /root/hive-control-center
node deploy-docker.mjs --image-variant dind
node deploy-docker.mjs --reset-docker
node deploy-docker.mjs --image-variant plain --keep-inactive-variant
node deploy-docker.mjs --mtproxy
node deploy-docker.mjs --mtproxy-only
```

## Verifying disk after a deploy

```bash
ssh root@<server-ip> 'docker system df'
```

Expect something close to:

```
TYPE         TOTAL   ACTIVE  SIZE     RECLAIMABLE
Images       2       1       54 GB    0 B (0%)    # dind + committed image
Containers   1       1       0 B      0 B
Volumes      0       0       0 B      0 B
Build Cache  0       0       0 B
```

If `RECLAIMABLE` is large, you probably switched variants with
`--keep-inactive-variant` set, or have stale state from manual experiments.
Re-deploy without `--keep-inactive-variant`, or use `--reset-docker` for a
full wipe.
