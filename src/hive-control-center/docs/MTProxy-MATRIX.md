# MTProxy configuration matrix

`scripts/mtproxy/proxy-matrix.mjs` tests several MTProxy configurations from the
current client network. Before every test it redeploys **only** the proxy
container with `--mtproxy-only --mtproxy-update`, runs a Telegram API check
through that configuration, records the result, and finally redeploys and keeps
the best available configuration on the server.

This is the per-network decision tool: run it after changing Wi-Fi, mobile
network, VPN, or relay, and compare the JSON/Markdown summaries.

## Safety

- The matrix never touches the hive-mind bot. It uses the append-only
  `--mtproxy-only` path and recreates only proxy containers.
- Before each deploy it removes the known MTProxy containers
  (`mtproxy`/`mtproxy-classic-<port>`) so switching engines or ports cannot hit
  a port conflict. The final deploy recreates the selected configuration.
- Each configuration is tested in the same order and with the same Telegram API
  account/session.
- Secrets are read from the server after deployment, never printed, never passed
  on a command line, and never written to the summary. The API test receives
  them through a mode-0600 temporary file.
- The final selected configuration is redeployed even if it was already current,
  so a failed experiment cannot leave the server without its best proxy.
- Other matrix-created proxy containers are removed after selection unless
  `--no-cleanup` is used. The selected container and its `/root` secret volume
  are kept.
- If SSH is blocked, no deploy is attempted and every result is marked
  `BLOCKED`; the summary still records the preflight failure.

## Requirements

- Run from `src/hive-control-center` so the root `.lenv` is found.
- `.lenv` with `SERVER_IP`, `SERVER_USER`, and `SERVER_PASS`.
- `sshpass` installed locally.
- Telegram API credentials in `--telegram-env` or `TELEGRAM_ENV_FILE`, plus the
  matching `.telegram_session` next to that file.
- The server already has Docker and the ability to run the proxy-only deploy.

## Usage

```bash
# See every built-in configuration without changing anything
node scripts/mtproxy/proxy-matrix.mjs --list

# Print the deploy commands without changing the server
node scripts/mtproxy/proxy-matrix.mjs --dry-run

# Run the full matrix from this network
TELEGRAM_ENV_FILE=/path/to/telegram.env \
  node scripts/mtproxy/proxy-matrix.mjs

# Run only the useful fallback set
TELEGRAM_ENV_FILE=/path/to/telegram.env \
  node scripts/mtproxy/proxy-matrix.mjs \
  --only classic-baseline,classic-workers-2,classic-mss-1024,mtg-contabo

# Force the media/photo checks on the baseline
TELEGRAM_ENV_FILE=/path/to/telegram.env \
  node scripts/mtproxy/proxy-matrix.mjs \
  --only classic-baseline --tests text,media,photo
```

The command prints a table and writes both files to
`data/mtproxy-matrix/mtproxy-matrix-<timestamp>.{json,md}`. The JSON is intended
for comparison and automation; the Markdown is the readable report.

## Built-in configurations

| id                   | engine  | port | workers | MSS  | extra                             | checks      |
| -------------------- | ------- | ---- | ------- | ---- | --------------------------------- | ----------- |
| `direct`             | direct  | -    | -       | -    | bypass proxy                      | text        |
| `classic-baseline`   | classic | 443  | 4       | 1200 | known-good image                  | text, media |
| `classic-workers-2`  | classic | 443  | 2       | 1200 | fewer workers                     | text        |
| `classic-workers-6`  | classic | 443  | 6       | 1200 | maximum workers                   | text        |
| `classic-mss-1024`   | classic | 443  | 4       | 1024 | lower MSS clamp                   | text        |
| `classic-mss-1300`   | classic | 443  | 4       | 1300 | higher MSS clamp                  | text        |
| `classic-port-8443`  | classic | 8443 | 4       | 1200 | alternate port                    | text        |
| `classic-beta-image` | classic | 443  | 4       | 1200 | `telegrammessenger/proxy:2.0beta` | text        |
| `mtg-contabo`        | mtg     | 443  | -       | 1200 | `contabo.com` fronting            | text        |
| `mtg-google`         | mtg     | 443  | -       | 1200 | `www.google.com` fronting         | text        |
| `mtg-vk`             | mtg     | 443  | -       | 1200 | `vk.com` fronting                 | text        |

`media` means the API test uploads a document and a photo and verifies both
downloads. `photo` means the explicit solid-color round-trip check. Text is
always checked.

## Custom configurations

Supply a JSON array with `--config`. This replaces the built-in list, so include
every configuration you want to test. Do not put secrets in this file.

```json
[
  {
    "id": "classic-443-w4-mss1200",
    "label": "Classic baseline",
    "engine": "classic",
    "port": "443",
    "workers": "4",
    "mss": "1200",
    "tests": ["text", "media"],
    "preferred": true
  },
  {
    "id": "mtg-443-google",
    "engine": "mtg",
    "port": "443",
    "mss": "1200",
    "frontingHost": "www.google.com",
    "tests": ["text"]
  }
]
```

Allowed `tests`: `text`, `media`, `photo`. Optional fields: `classicImage`,
`image`, `frontingHost`, `notes`, `preferred`, `noProxy`. `preferred` only
breaks score ties; it never outranks a configuration that passed more checks.

## Selection

A configuration is eligible only if its deploy succeeded and its text check
passed. Scores are:

- text: 1
- media: +5
- explicit photo round-trip: +1

The highest score wins. Ties prefer `preferred: true`, then the faster API test,
then the earlier matrix position. If nothing passes, the baseline classic
configuration is restored so the server is left in the known-good state.

The selected configuration and the reason are recorded in the summary and in the
final console output. Use `--no-keep-best` to leave the last tested
configuration instead, or `--no-cleanup` to keep experimental containers.

If the winner uses a non-443 port, the Telegram app still points at 443; update
the app profile or prefer the baseline unless the alternate port is intentional.

## Interpreting results

- `deploy: FAIL` — the proxy-only redeploy failed; later configs still run.
- `text: FAIL` — the Telegram API could not complete through that proxy.
- `media: FAIL` — text worked but document/photo transfer did not.
- `photo: FAIL` — the explicit solid-color photo check failed.
- `PARTIAL` — text passed but a requested media/photo check failed.
- `BLOCKED` — SSH preflight failed; no deploy was attempted.

Do not compare results across networks by raw duration alone. Compare the
`text`, `media`, and `photo` columns, then use the JSON bytes/status lines for
detail. The matrix is deliberately proxy-only; relay/overlay methods still need
their own network-path tests.

## Environment variables

| Variable                | Meaning                                                                                       |
| ----------------------- | --------------------------------------------------------------------------------------------- |
| `TELEGRAM_ENV_FILE`     | Telegram API credentials and `.telegram_session` location.                                    |
| `TELEGRAM_SESSION_FILE` | Explicit session path override.                                                               |
| `MTPROXY_*`             | Read by the deploy script from `.lenv`; CLI flags from the matrix override the tested fields. |

Never commit `.lenv`, Telegram sessions, proxy secrets, matrix JSON/Markdown
outputs, or deploy logs.
