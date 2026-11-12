# Stuck `gh-upload-log` / sanitizer processes

Upstream report: https://github.com/link-foundation/gh-upload-log/issues/65

## What it looks like

- One or more `bun .../gh-upload-log` processes in `hive-mind` use a whole core
  each for tens of minutes or hours.
- The process is not uploading: its input and output file positions stop
  changing.
- The bot may restart the upload after a kill, creating another stuck process.

Real example (2026-11-12): two processes on one 222 MB log, each ~99% CPU for
over an hour, both at `read=61472768`, `write=11159293`. The write position
stopped just before input byte `11215452`, line `43830`:

```text
default = ["macro"]
```

## Root cause

`@link-foundation/sensitive-data-sanitizer` `src/stream.js`
(`advanceCredentials` / `releaseBoundary`) treats any line starting with
`default ` as the start of a netrc block:

```js
/^\s*(?:machine\s+\S+|default)(?:\s|$)/;
```

`default = ["macro"]` matches, but no later line completes
`machine|default login ... password ...`. The sanitizer therefore never
releases a boundary and repeatedly slices/rescans a growing buffer. That is
quadratic CPU. It is present in sanitizer `0.22.3`; updating `gh-upload-log`
alone does not fix it.

## Auto-fix commands

```bash
# Report only
node auto-fix.mjs --check-uploads

# Kill only confirmed stuck processes (no fd progress over the sample window,
# at least --stuck-upload-percent of a core for --stuck-upload-minutes)
node auto-fix.mjs --check-uploads --kill-stuck-uploads

# Tune the thresholds
node auto-fix.mjs --check-uploads \
  --stuck-upload-minutes 45 --stuck-upload-percent 90
```

`--diagnose` also runs the check read-only. A normal run and its monitor poll
run it too; only `--kill-stuck-uploads` lets them kill anything.

The last result is written to `data/stuck-uploads-last.json`.

## What the check records

- PID, command (redacted), container, age, current and lifetime CPU.
- Installed `gh-upload-log` and
  `@link-foundation/sensitive-data-sanitizer` versions.
- Every regular file fd: path, byte position, size, and position change over
  the sample window.
- Input path, sanitized output path, and the first netrc-like `default` line
  with its byte offset.
- Whether the process is confirmed stuck and whether it was killed.

## Manual forensics

```bash
# Find the processes
ps -eo pid,ppid,etime,pcpu,stat,comm,args |
  awk '$6=="bun" && $0 ~ /gh-upload-log/'

# Read/write positions twice
readlink /proc/PID/fd/6
awk '/^pos:/{print $2; exit}' /proc/PID/fdinfo/6
awk '/^pos:/{print $2; exit}' /proc/PID/fdinfo/7

# First lines that look like netrc starts
awk '{ off += length($0)+1;
  if ($0 ~ /^[[:space:]]*default([[:space:]]|$)/)
    print NR, off-length($0)-1, substr($0,1,120) }' /tmp/hive-mind-log-upload-*/session-log.part-1-of-9.log

# Installed versions
grep -m1 '"version"' \
  /home/box/.bun/install/global/node_modules/gh-upload-log/package.json \
  /home/box/.bun/install/global/node_modules/@link-foundation/sensitive-data-sanitizer/package.json
```

## Killing is not the fix

The bot retried immediately after each kill with `session-log.part-1-of-9.log`;
part 1 still contained the trigger line. Kill to stop the CPU burn, then update
`gh-upload-log` after a sanitizer release fixes the netrc detector. See
[dependencies.md](dependencies.md).
