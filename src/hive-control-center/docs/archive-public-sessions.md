# archive-public-sessions.mjs

Publishes sanitized Claude Code and Codex CLI sessions that were recorded while
working on **public** GitHub repositories to a shared archive repository
(default `konard/public-repositories-sessions-archive`). It plays the role of
[gh-upload-log](https://github.com/link-foundation/gh-upload-log) for AI
sessions: discover, sanitize, convert, upload, keep provenance.

## Requirements

- Node.js 22 or newer (`nvm use 22`); the sanitizer does not run on Node 20.
- `git` and an authenticated GitHub CLI (`gh auth login`).
- Network access on the first run: the script installs
  [`@link-assistant/conversation`](https://github.com/link-assistant/conversation)
  and [`@link-foundation/sensitive-data-sanitizer`](https://github.com/link-foundation/sensitive-data-sanitizer)
  from GitHub at pinned commits into `~/.cache/archive-public-sessions/deps`
  (neither package is published on npm yet), and `lino-arguments` through `use-m`.

## Usage

```bash
node archive-public-sessions.mjs --list                    # what would be archived, and why files are skipped
node archive-public-sessions.mjs --dry-run --filter konard/p-vs-np --limit 5 -v
node archive-public-sessions.mjs                           # full run; creates the repository when missing
node archive-public-sessions.mjs --only codex --jobs 6 --push-every 500MB
```

Options can also come from environment variables or a `.lenv` file
(`SESSIONS_ARCHIVE_REPO`, `SESSIONS_ARCHIVE_WORK_DIR`, `SESSIONS_ARCHIVE_CHUNK_SIZE`,
`CLAUDE_PROJECTS_DIR`, `CODEX_SESSIONS_DIR`, ...). Run `--help` for the full list.

## How it works

1. **Discovery.** Claude sessions are `~/.claude/projects/*/<id>.jsonl`, plus
   `<id>/subagents/*.jsonl` and `<id>/tool-results/*`. Codex sessions are
   `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`. Files modified in the last
   `--min-age` minutes are skipped because they are still being written. The
   legacy 2025 Codex `rollout-*.json` files carry no working directory and are
   skipped as unattributable.
2. **Attribution.** A Claude session's `cwd` is resolved to its git remote; a
   Codex session carries `git.repository_url` in `session_meta`. Only
   `github.com` remotes whose repository the GitHub API reports as `public`
   are kept; private, unknown (404) and non-GitHub repositories are skipped.
3. **Sanitization.** Each JSONL record is parsed and every string value (and
   long key) is sanitized separately with the sanitizer's asynchronous engine
   (native rules + Secretlint + bundled Gitleaks rules + personal-data
   detection). Values whose key looks like a credential (`password`, `token`,
   `api_key`, `cookie`, ...) are always redacted. Known secret literals come
   from the environment, `gh auth token`, `.env`/`.lenv` files of the
   attributed repositories and `--known-secrets-file`; they are passed to the
   engine and additionally checked against every output file, which blocks the
   session if any literal survives. When the engine refuses a piece of text it
   is retried without bounded decoding and finally replaced by `[REDACTED]`
   (reported as `blockedPieces` in the metadata).

   The whole-file streaming mode of the sanitizer is deliberately not used:
   on session JSON it rejects batches (encoded-run limit) and redacts tool
   names, message ids and whole fields, breaking the record structure.
4. **Conversion.** The sanitized JSONL is imported with the `conversation`
   library and written as a `.lino` Links Notation archive next to it. Files
   above `--chunk-size` (default 40 MB, GitHub's hard limit is 100 MB) are
   split at line boundaries into `.part-NNN.jsonl` / `.part-NNN.lino`.
5. **Upload.** The archive repository is cloned blobless with a sparse
   checkout of `*.meta.json` and `README.md` only, so re-runs do not download
   gigabytes. New files are added with `git hash-object` / `git update-index`,
   committed and pushed in batches of `--push-every` bytes (GitHub rejects
   pushes above 2 GB). Pushes are retried after a fetch and rebase. A session
   whose source hash and sanitizer commit already match the archived
   `.meta.json` is skipped; `--force` re-processes everything.
6. **Report.** A JSON report (counts, failures, per-session file lists; no
   secret values) is written to the work directory and the archive `README.md`
   is regenerated with a per-repository table.

## Layout of the archive repository

```
<owner>/<repo>/claude/<session-id>.jsonl
<owner>/<repo>/claude/<session-id>.lino
<owner>/<repo>/claude/<session-id>.meta.json
<owner>/<repo>/claude/<session-id>/subagents/agent-*.jsonl|.lino|.meta.json
<owner>/<repo>/claude/<session-id>/tool-results/*.txt|.meta.json
<owner>/<repo>/codex/YYYY/MM/DD/rollout-*.jsonl|.lino|.meta.json
```

## Known limitations

- Sanitization is heuristic. Over-redaction is common (home-directory user
  names, `@scope` package names, YAML `name:` fields and some numbers become
  `[REDACTED]`); under-redaction is possible for unknown token formats. Review
  the archive and open an issue for anything that slipped through.
- Throughput is about 0.4 MB/s per worker; the initial 3.6 GB backlog takes a
  few hours with four workers.
- The `.lino` conversion is derived from the sanitized `.jsonl` and is not
  scanned a second time.

## Identity documents and exclusions (added 2026-10-08)

The first full publication leaked passport MRZ lines, a booking reference
and birth dates from `konard/documents-processing` sessions: the sanitizer
does not recognize these formats. The archive repository was switched to
private as containment. The script now:

- redacts passport MRZ lines, passport/visa numbers, booking references and
  labelled birth dates before running the sanitizer;
- blocks a session entirely if MRZ-like data survives;
- supports `--exclude owner/repo` (or `SESSIONS_ARCHIVE_EXCLUDE`) for
  repositories whose sessions handle personal documents and must never be
  published;
- runs at most `--large-jobs` (default 1) sessions above `--large-size`
  (default 50MB) at once. Running six large sessions in parallel got workers
  killed for memory; one 70MB session alone peaks at about 1.2 GB and takes
  about 12 minutes.

The leaked data is still in the archive's git history. Making it public
again requires rewriting that history or recreating the repository.

## Masking and explicitly fake data (added 2026-10-08)

Identity values (MRZ lines, passport and visa numbers, booking references,
labelled birth dates, phone numbers after messenger labels) are masked as
`ab***yz`: first two and last two characters, with values shorter than 5
characters fully replaced by `[REDACTED]`. They are kept unchanged only when
they are explicitly fake:

- ICAO Doc 9303 and national specimens (`UTO`, `ERIKSSON`, `L898902C3`,
  `SPECIMEN`, `ОБРАЗЕЦ`, `MUSTERMANN`, ...);
- obviously synthetic numbers: one repeated digit, or 6+ consecutive
  ascending/descending digits in the document number;
- values listed in a reviewed file passed with `--fake-values-file`
  (`SESSIONS_ARCHIVE_FAKE_VALUES_FILE`), kept outside the archive.

Words like "test" or "fake" near a value are not enough: the leaked real data
was itself discussed as "real-data tests". Each `.meta.json` reports
`identityMasked` and `fakeIdentityKept`.

`konard/documents-processing` is excluded by default because its sessions
contain family names in plain text and file names that no generic rule can
detect. Override with `SESSIONS_ARCHIVE_EXCLUDE` only after a manual review.

Upstream issues: link-foundation/sensitive-data-sanitizer#3 to #12.
