# Incident 2026-10-07: deploy broken by command-stream 2.0.0, plus log audit

## What broke

1. **`command-stream@2.0.0`** (published 2026-10-07 08:06 UTC) was picked up by the
   unpinned `use('command-stream')`. It requires Node >=22 and depends on
   `node-pty@^1.1.0`, which ships no linux-x64 prebuilds. On the server (Ubuntu 24.04,
   Node 20.20.2, no `make`) npm fell back to `node-gyp rebuild` and failed.
   1.6.2 used `node-pty@1.2.0-beta.15`, which has prebuilds for all platforms.
2. **use-m left a dangling bin link.** After that failed install, use-m deleted
   `/usr/lib/node_modules/command-stream-v-latest` but left
   `/usr/bin/command-stream -> ../lib/node_modules/command-stream-v-latest/src/zx/cli.mjs`.
   `command-stream` has declared a `bin` since 1.4.0, so every later alias install
   (`command-stream-v-1.6.2`) failed with `EEXIST`. use-m's own EEXIST fallback
   (`--force --no-bin-links`) never ran: it proves ownership by reading the old
   alias's `package.json`, which no longer existed.

## Workarounds in this repo (all scripts and the gist)

- Pinned: `https://unpkg.com/use-m@8.16.4/use.js`, `command-stream@1.6.2`, `lino-arguments@0.3.0`.
- Before `use()`, a block unlinks `$(npm prefix -g)/bin/command-stream` only if it is
  a symlink whose target is gone and points into a `command-stream-v-*` alias.
  Tested: removes a dangling link, keeps a healthy one, ignores other packages' links.
- **Unpin only when** command-stream#218 and use-m#78 are fixed. Moving to
  command-stream 2.x also needs Node >=22 on the server; Step 12 of
  `deploy-remote-docker.mjs` still installs Node 20, which is end-of-life since April 2026.

## Upstream reports

- link-foundation/command-stream#218: 2.0.0 node-pty has no linux prebuilds (regression from 1.6.2).
- link-foundation/use-m#78: a failed install leaves a dangling bin link and later EEXIST.
  A comment there proposes always installing with `--no-bin-links`, since use-m only imports modules and never needs their CLIs.
- link-foundation/use-m#79: resolve `latest` to the newest version whose `engines.node` matches the running Node.
- link-assistant/hive-mind#2699: agentic CLI updater reports false failures because it trusts wrong `--version` output.
- link-assistant/claude-profiles#57: `--version` prints nvm's version (0.40.7). There is no `.version()` call, so yargs guesses and finds `~/.nvm/package.json`.
- link-foundation/gh-setup-git-identity#30: `--version` is hard-coded to `0.1.0`.

hive-mind itself was not affected: it pins command-stream 2.0.0 in `src/use-with-retry.lib.mjs` and runs Node 24 in its image.

## Log audit fixes (successful deploy at 21:02 UTC)

| Log symptom | Real cause | Fix |
|---|---|---|
| Step 4 `Permission denied` ×3 then ✅ | The swap script never ran (sshpass exit 5); ✅ came from an independent swap probe | Warn when the script fails. `ssh`/`sshTTY`/`scp` retry up to 4× on exit 5; that's safe because the command never ran |
| `Load key "~/.ssh/id_ed25519": Is a directory` on every call | That path is an empty directory on this Mac; ssh offered keys first | `-o PubkeyAuthentication=no -o PreferredAuthentications=password,keyboard-interactive` |
| Step 5 `free on / right now: 0 GB` | SSH probe failed; probes turned a failure into 0 | Probes return `null` and print "unknown (probe failed)"; total-disk gate explains a probe failure instead of saying "disk too small" |
| Step 6 boot time 2h ahead of headers | `uptime -s` is server-local time (Europe/Berlin) | `TZ=UTC uptime -s`, suffixed `UTC` |
| Step 9 `speedup is 2,373.48   .15K bytes/sec` | `.trimEnd()` stripped the newline after rsync's `sent … received …` line, so the next `\r` overwrote it | Split output on `\r`/`\n`: `\n` lines stay, `\r` lines redraw |
| `history merged …: 69 lines (kept 0 from mirror, +12 new)` | "kept" meant "lines only in the mirror" | Reworded: `69 lines = 57 on both sides + 12 new from server + 0 kept that only the mirror has` |
| Step 10 `not present on server` for all buckets | Folders existed but were empty; `du -sb` printed 0, which the code treated as falsy and so as missing | 0 means "already empty". The summary says "Nothing to empty" instead of "Emptied 0/3 … (safely backed up …)" |
| Image "~27 GB" | konard/hive-mind-dind 2.34.0 is 32.7 GB on disk | `IMAGE_SIZE_GB = 33`, so the total-disk gate requires 57 GB |
| Remote Step 10 `No such container: hive-mind` | Unconditional `docker rm -f` | Removes the container only if `docker ps -aq --filter name=^/hive-mind$` finds it |
| Remote Step 31 codex "did not confirm working (exit 1)" | **False negative**: probe hard-coded `--model gpt-5.4-mini`, which returns HTTP 400 "not supported when using Codex with a ChatGPT account". The warning showed only codex's banner | Probe uses the account's default model (`gpt-6.1-sol` in config; verified `OK_CODEX_PROBE`) with `</dev/null`. The warning shows the error lines |

## Still open / noted

- **Security:** root password SSH is brute-forced (8,294 failed logins on 2026-10-07, up to
  1,098 from one IP). The root password and Telegram bot token were also printed in a Claude
  session on 2026-10-07. Rotate both and move to key-only SSH (or fail2ban, with the deploy machine's IP allowed).
- **Our own correct password was sometimes rejected:** sshd logged "Failed password" for
  the deploy machine's IP (14.254.0.190) at 22:32 and 22:58 server time, on isolated connections, with no
  `pam_unix … authentication failure` line (unlike attacker attempts). Cause not determined;
  the exit-5 retry covers it.
- Container docker client 29.8.0 vs host daemon 29.6.1 shows `API version 1.55 (downgraded from 1.56)`.
  This is informational only; upgrading docker-ce on the host would remove it.
