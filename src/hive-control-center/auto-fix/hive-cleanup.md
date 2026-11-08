# Targeted cleanup of preserved failures

Run the actual installed `hive-cleanup` CLI through auto-fix after preserving
the complete writable layers and recording the already-published failure reports:

```sh
node auto-fix.mjs --cleanup-failed data/cleanup-preservation-receipt.json --dry-run
node auto-fix.mjs --cleanup-failed data/cleanup-preservation-receipt.json
```

This standalone mode runs no recovery, reporting, global-tool cleanup, ordinary
temporary-directory cleanup, image/volume pruning, or DSS cleanup.

The receipt uses schema `auto-fix-failed-cleanup-v1`, `preservationVerified: true`,
and these fields:

- `backupDirectory`: protected host directory below
  `/root/.hive-mind/failed-task-backups/`, containing the original `receipt.json`.
- `archive`: `path`, `bytes`, SHA-256, `compression_test_passed: true`, and
  `kind: "complete-stopped-writable-layers"`.
- `targets`: exact container `name`, immutable `id`, `exitCode`, `finishedAt`,
  execution UUID, existing Hive Mind `reportUrl`, and verified `failureComment`.

Auto-fix verifies the host receipt, archive size and SHA-256, selected container
identities, stopped state, and failure timestamps before invoking hive-cleanup.
The backup must preserve every byte of each target's writable layer, container
metadata/logs, and execution records. Shared authentication and conversation
mounts stay on the host and must never be removed by this mode.

The CLI receives an empty private temporary root, disabled agent-snapshot and
session/branch/folder discovery, and a Docker adapter that lists only the selected
failures plus running containers. Its `rm -f` requests become unforced removals
by immutable ID after a fresh state/timestamp check. Other mutations are refused.
Docker therefore rejects a concurrent restart. Missing backups, changed attempts,
and unselected containers cannot be removed.

The adapter requests Docker's planner fields individually. The installed CLI's
`{{json .}}` listing also requests sizes, which can exceed its 20-second timeout
on containerd-backed hosts and silently produce an empty cleanup plan. The
adapter avoids that walk, and auto-fix requires the preview's removal count to
match the selected targets instead of accepting an empty plan as success.

On completion, auto-fix verifies removal and the protected container identities,
records existing reporting coverage in its duplicate ledger, and writes both
the result and a durable ledger copy beside the host backup. It saves a local
result under `data/hive-cleanup-result-*.json` too. Keep the protected backup
until its code, conversation, and diagnostic preservation is no longer needed.

The backup is a forensic archive of upper layers, with ACLs, xattrs, hard links,
sparse data, and original numeric owners. To reconstruct a container filesystem,
use the exact base image recorded in the metadata; restoring only an upper layer
as a standalone root filesystem is insufficient. Never blindly extract archived
authentication/configuration into the active shared AI homes.
