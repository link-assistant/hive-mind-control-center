# Updating global dependencies in `hive-mind`

The bot installs its global CLI tools with Bun in
`/home/box/.bun/install/global` inside the `hive-mind` container. Auto-fix has
two standalone modes; neither runs recovery, reporting, cleanup, or disk work.

## One dependency

```bash
# Preview
node auto-fix.mjs --update-dependency gh-upload-log --dry-run

# Update gh-upload-log and its transitive dependencies
node auto-fix.mjs --update-dependency gh-upload-log
```

`bun update -g --latest gh-upload-log` updates the named top-level dependency
and the dependencies it allows within the new release. In particular, updating
`gh-upload-log` updates its pinned
`@link-foundation/sensitive-data-sanitizer`.

## All dependencies

```bash
# Preview every change
node auto-fix.mjs --update-all-dependencies --dry-run

# Update every top-level global dependency
node auto-fix.mjs --update-all-dependencies
```

This is a large change (often dozens of packages). Preview first. The command
can take several minutes.

## Safety

- Before a real update, `package.json`, `bun.lock`, and `bun.lockb` are copied to
  `/home/box/.hive-mind/state/auto-fix-dependency-backups/<timestamp>/` inside
  the container. The path is printed and stored in the result.
- The result, including before/after versions and Bun's output, is written to
  `data/dependencies-result-*.json` (or `dependencies-preview-*.json`).
- A failed update leaves the backup in place; restore it before retrying.
- The `gh-upload-log` netrc hang (gh-upload-log#65) is **not** fixed by 0.13.2 /
  sanitizer 0.22.3. Check the issue before updating only for that bug. See
  [stuck-uploads.md](stuck-uploads.md).

## Manual equivalent

```bash
ssh <server>
docker exec -u 1001 hive-mind bash -lc \
  'cd /home/box && bun update -g --latest --dry-run gh-upload-log'
docker exec -u 1001 hive-mind bash -lc \
  'cd /home/box && bun update -g --latest gh-upload-log'
```
