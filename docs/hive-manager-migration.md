# Migrate Control Center operations to Hive Mind Manager

Use Hive Mind **2.48.0** for the staging exercise. Keep the SSH configuration, profiles, credentials, active-task records, incident routes, and scheduler with the deployment that owns them. The [command inventory and verification record](case-studies/issue-1/README.md) lists the release gaps and the requirements for moving each live caller.

## Prepare the operator and staging host

Install the pinned CLI in a private operator directory with Node.js 24 or later.

```bash
umask 077
npm install --prefix "$HOME/.local/hive-manager-2.48.0" --omit=optional @link-assistant/hive-mind@2.48.0
manager="$HOME/.local/hive-manager-2.48.0/node_modules/.bin/hive-manager"
"$manager" --version
```

Expect `2.48.0`. The pinned executable sends its Bash program over OpenSSH. For commands that dispatch package modules on the host, also install 2.48.0 on the target and verify `ssh ALIAS hive-manager --version` resolves it on the noninteractive PATH. Check the container version independently when running commands inside the deployment. The operator's local environment variable `HIVE_MANAGER_PACKAGE_VERSION` does not pin the remote npm fallback. [Release documentation](https://github.com/link-assistant/hive-mind/blob/v2.48.0/docs/deployment/hive-manager.md), [SSH package pin](https://github.com/link-assistant/hive-mind/issues/4135)

Copy [staging.conf](../examples/hive-manager/staging.conf) to a new profile directory on the target through the existing SSH alias. The profile uses the pinned plain image, a distinct name, and a state directory relative to the profile. Verify host keys, the configured jump chain, capacity to pull the image, and permission to use Docker and read its service journal. With the deployment's actual staging alias and remote profile path, run:

```bash
stage_host=hive-staging
stage_profile=./hive-manager-stage/staging.conf
stage=("$manager" --host "$stage_host" deploy --profile "$stage_profile")

ssh "$stage_host" hive-manager --version
"${stage[@]}" --dry-run --setup apply
"${stage[@]}" docker-service status
"${stage[@]}" doctor
"${stage[@]}" prepare
"${stage[@]}" --setup apply
"${stage[@]}" status
"${stage[@]}" doctor
"${stage[@]}" diagnose --since '1 hour ago' --resources
"${stage[@]}" disk --budget 30
```

The setup container runs without a Telegram bot token. Record the SSH route, Docker daemon ID, image digest, container ID, and resolved mounts in a private operator log. Inspect diagnostic results for missing permissions or unavailable data. Keep any test bot token and allowlist in a separate staging environment file readable by the deployment account.

### Prove backup, update, rollback, and interrupted-update recovery

Create a harmless marker inside a staging state mount, then take an application-consistent backup. The manager streams the profile's state directory. Use the existing private backup procedure for any separate config, Docker volumes, or provider snapshots. Keep the local archive and restored directory private.

```bash
"${stage[@]}" exec -- bash -c 'printf "staging probe\n" > "$HOME/.codex/migration-probe"'
"${stage[@]}" stop
(umask 077; set -o noclobber; "${stage[@]}" backup --output - > stage-state.tar.gz)
"$manager" --host "$stage_host" deploy --state-dir ./hive-manager-stage/restored-state \
  restore < stage-state.tar.gz
"${stage[@]}" start
"${stage[@]}" --setup update
"${stage[@]}" exec -- cat /home/box/.codex/migration-probe
"${stage[@]}" rollback
"${stage[@]}" exec -- cat /home/box/.codex/migration-probe
"${stage[@]}" recover
```

Check the marker in the restored directory, verify expected file ownership, and verify that restore rejects a second write to that directory. Confirm that update selects a different container and rollback returns to the recorded predecessor with the marker intact. With the staging name only, use `--no-pull update -- false` to exercise an unsuccessful replacement and check that the prior container remains running. Use the [isolated SSH smoke experiment](../experiments/issue-1/staging-smoke.sh) for the controlled interrupted-update case. If recovery is needed on a deployment, capture candidate and predecessor IDs and status before running `recover`, then verify the selected container, mount contents, and bot readiness. Rollback switches containers while shared state keeps its current contents. Restore state from a backup only after reviewing changes since the snapshot.

## Cut over the bot without changing the task daemon

The legacy default uses `konard/hive-mind-dind` with `DIND_SKIP_DAEMON=1` and mounts the host socket at `/var/run/docker.sock`. Existing tasks and watchers depend on that daemon and their host-side mount sources. By default, a manager `variant=dind` profile starts a nested daemon, even if `docker-socket` is configured. A `variant=plain` profile with `docker-socket=/var/run/docker.sock` selects the host daemon. For a staging comparison with the DinD image, set `DIND_SKIP_DAEMON=1` and `TELEGRAM_ISOLATION=docker` in the deployment's environment file. Set `HIVE_MIND_DOCKER_ISOLATION_IMAGE` to the recorded full task image reference, including repository and digest. Verify the image entrypoint, credentials, and Docker socket permissions there.

The released mount resolver can translate a task source beneath an existing parent bind or volume. It refuses a path that only exists in the bot's writable layer. When the task tool requires shared XDG data, provision it on a private persistent bind, for example `XDG_DATA_HOME=/home/box/.hive-mind/tool-data` on the manager profile's `hive` mount. Review the actual sources for the configured tools and run the isolated launch and watcher check before using the profile with existing tasks.

Before adoption, freeze automated updates and record the production image digest, Docker daemon ID, task image, startup command, credential and Git mounts, configuration, and active/paused task and watcher state. Back up task records, logs, and state held only in the old container, plus any named volumes and files outside the manager state directory. Preserve the old container and ownership of its state for rollback. Prefer a deployment-owned Compose definition, invoked through `hive-manager --host ALIAS deploy compose`, if it already preserves the deployed mount and daemon layout. Keep the existing Docker entry points available until the replacement launches an isolated task with the same daemon and image, resolves its credential/Git/transient mounts from the host, and reconciles its watcher over a restart. [Host Docker socket tracking](https://github.com/link-assistant/hive-mind/issues/1962)

For an instance proven to use the correct layout, preview `deploy --profile PROFILE --adopt --dry-run apply` before applying with `--adopt`. Compare mounts, UID, image, and startup command to the working instance. Keep the task launch and watcher evidence alongside the deployment record. Validate `status`, `logs`, and an authorized bot request after the switch. Do not retire the old runbook while its rollback is needed.

## Disk, tasks, watchers, and incidents

Run these commands with the deployment's actual `--host` and `--profile`. Save previews and receipts in a private operator directory.

| Workflow                    | Manager command after `deploy --profile PROFILE`                                                                         | Check before moving the caller                                                                                                                                                                                                                     |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Storage and diagnostics     | `disk --budget 30`, `doctor`, `diagnose --since '1 hour ago' --resources`                                                | Compare per-task attribution for running, paused and stopped tasks. Investigate unavailable measurements and host permissions.                                                                                                                     |
| Scoped cleanup              | `cleanup --scoped --dry-run`, then `cleanup --scoped --status`                                                           | Compare the protected paths, scope, memory guards and exact preview. Use `--apply PREVIEW_ID` only for the reviewed preview. Check status after SSH loss and request a fresh preview after interruption or partial apply.                          |
| Failed-task retention       | `tasks preserve-layer CONTAINER --output NEW_DIRECTORY`, then `tasks cleanup-preserved NEW_DIRECTORY`                    | Verify the stopped container, writable-layer evidence, execution record and task logs. Back up mounted data independently. Use `--apply DIGEST` only after verifying the private backup. Use `backup-container` for a flattened filesystem export. |
| Active tasks and watchers   | `tasks list --running`, `tasks status UUID`, `tasks attach UUID --read-only`                                             | Compare the daemon, container ID, execution UUID, attempt and watcher before and after update.                                                                                                                                                     |
| Reconciliation and recovery | `tasks repair-records UUID`, `tasks resume-all`, `tasks recover-failed --execution UUID --attempt N --max-resumes COUNT` | Match the stored attempt to the running snapshot. Use `resume-all` for records already marked executing. Preview alias exit 127 and later eligible retries with the original resume policy, and inspect snapshot headroom before applying.         |
| Tool maintenance            | `update-dependencies`, `global-tools --policy FILE`, `tool-services --tools codex,claude`, `tasks check-uploads`         | Compare the profile's config allowlist, dependency backups and service blockers. Use the release guide's host prerequisites. Upload termination requires `--terminate PID` and an identity and progress recheck.                                   |
| Incident evidence           | `tasks report --group`, `tasks report --collect UUID --attempt N`, `diagnose --task UUID --attempt N`                    | Match known attempts to their log offsets, daemon journal and historical route.                                                                                                                                                                    |

See the [manager maintenance guide](https://github.com/link-assistant/hive-mind/blob/v2.48.0/docs/deployment/hive-manager.md#maintenance-and-diagnostics) for host and container prerequisites, selectors, and rollback.

To compare a saved task inventory offline, capture the start-command JSON list from the selected deployment in a private file and pass it to the migration command. It uses the pinned manager's public JavaScript library to count states and group historical failures, including failures in tasks whose latest attempt succeeded.

```bash
(umask 077; set -o noclobber; "${stage[@]}" tasks list --output-format json > task-records.json)
(umask 077; set -o noclobber; node src/hive-control-center/auto-fix.mjs \
  --inspect-task-snapshot task-records.json > task-summary.json)
```

Use `HIVE_MANAGER_PREFIX` if the package is installed in a different prefix. Keep snapshots and summaries private.

To check historical reporting, preview `deploy tasks report --incident UUID --attempt N --destination OWNER/REPO --reconcile --legacy-ledger FILE`. Put the ledger and reviewed route file in the environment that runs the command. For a publication preview, use `--routes FILE` in place of the reconciliation flags. Verify the backend, exit code, signature, matching attempt, selected issue and previous report markers. Use `--host-signature` only with journal evidence for that attempt. Review closed issue routes and their recorded version against the legacy ledger. Use `--publish REVIEW_DIGEST` for the individually approved plan. Scheduled multi-attempt reporting still uses the existing deployment procedure. [Automatic incident reporting](https://github.com/link-assistant/hive-mind/issues/4132)

To recover the bot queue, retain verbose logs from before and after the restart, both including queue initialization. Run locally on those files:

```bash
"$manager" tasks recover-queue --previous previous.log --current current.log
```

Confirm each candidate is absent from the live queue and active task records. If raw commands are needed, use `--include-commands` in a private terminal. Check dependencies, sandbox settings and authorized chat with the request owner. Resubmit each confirmed lost request once through that chat, then record its new task ID or queue entry and verify its status.

## MTProxy maintenance and client checks

Record the existing name, port, image, secret hash, workers, connection limits, and MSS rules. The documented legacy classic deployment uses 443, four workers, an MSS of 1200, and a nofile limit of 524288. Confirm the actual settings on the target. An independent 8443 stage needs its own name and state.

- Use `deploy proxy --proxy-name NAME --port PORT status` and `verify`. Save a baseline with `--check-egress --check-mss snapshot`. Use `--secret-file FILE` to read the existing key in place on the Docker host. Compare the candidate against that baseline using `compare -` and stdin.
- Use `deploy --adopt proxy --proxy-name NAME --port PORT apply` to migrate a legacy classic proxy after checking the mounted or supplied secret. Keep the predecessor until the affected client network passes the checks below. For another engine such as FakeTLS, stage a stopped candidate with the same selected host port. Use `trial-plan`, review container IDs and bindings, then run `trial -` with the approved plan. Use `rollback` to restore the predecessor and `accept` after successful client verification.
- Use `proxy inventory` to inspect legacy containers. Review a `cleanup-plan` with an explicit `--select NAME` for each chosen resource. Include `--legacy-mss` only when the old unit and all its associated rules belong to the change. Keep its source and current settings for rollback. For manager-owned IPv4 rules, review `mss-unit` before installing it. Use `capture` and `proxy-pcap --compare` for bounded paired captures when the media probe stalls.

Run the pinned release **from the affected network** using an authorized test account, a private Telegram API credentials file, a preauthorized StringSession, and the proxy secret. Use the same text, exact document and decoded photo checks on direct, baseline and candidate routes. [Manager proxy guide](https://github.com/link-assistant/hive-mind/blob/v2.48.0/docs/deployment/hive-manager.md#telegram-mtproto-proxy)

```bash
probe=("$manager" proxy-test --credentials ./telegram-api.json --session-file ./test.session)
"${probe[@]}" --direct --media --roundtrip-photo
"${probe[@]}" --proxy-host "$proxy_host" --proxy-port "$proxy_port" \
  --secret-file ./mtproxy.secret --media --roundtrip-photo
```

Use `--photo FILE` if the deployment needs a specific harmless photo. Record the network, timestamp, release, port, candidate settings and result. Keep raw captures and secrets in the deployment's private workspace. The [legacy verification record](../src/hive-control-center/docs/MTProxy-VERIFICATION.md) describes the known client-network symptoms.

## Move the private archive scheduler

1. Identify the live schedule, account, source paths, repository allowlist, attachment and LINO settings, age policy, and private redaction inputs. Pause the scheduler in its owning deployment and check that no publisher is running. Record the destination's current Git tip and keep its existing private branch and history. Verify privacy, default branch, push permission, and access to inactive sources using the scheduler's account.
2. Run a bounded marker-only legacy import preview as the scheduler account. Use the same policy for import and incremental publication. Extend `policy` only with the approved `--only`, `--lino`, `--tool-results`, and `--min-age` values. Supply `--known-secrets-file` for deployments that require extra literals.

   ```bash
   umask 077
   gh repo view "$archive" --json visibility,viewerPermission,defaultBranchRef
   policy=(--claude-dir "$claude_dir" --codex-dir "$codex_dir")
   redaction=(--known-secrets-file "$private_literals")
   source=("$manager" archive-sessions --repo "$source_repo" "${policy[@]}" "${redaction[@]}")
   "${source[@]}" --import-legacy "$archive" --limit 10
   "${source[@]}" --import-legacy "$archive" --limit 10 --apply "$import_digest"
   "${source[@]}" --published-in "$archive" --output "$review_dir" --limit 1
   "$manager" archive-publish "$review_dir" --destination "$archive" --private "${redaction[@]}"
   ```

   Inspect the import evidence and marker paths before applying. Repeat review for each import batch. Keep split or oversized legacy revisions and the historical README in place. Check import skips and any attachment, format or redaction differences against the deployment's policy. The manager records new batches in manifests. Its 40 MiB transcript limit can omit revisions that the legacy exporter splits. [Legacy import and publication](https://github.com/link-assistant/hive-mind/blob/v2.48.0/docs/deployment/hive-manager.md#import-an-existing-private-archive), [Oversized and split archives](https://github.com/link-assistant/hive-mind/issues/4134)

3. Inspect every staged file, the manifest, its destination, and its publication digest. Recheck privacy and the pause. Apply the first authorized incremental batch by repeating the same `archive-publish` command with `--apply "$publish_digest"`. Verify that the commit is a descendant of the recorded tip, that the diff matches the reviewed additions, and that the next preview skips the published revision.
4. Rehearse rollback on an isolated private Git destination with the same history shape while the scheduler is paused. The [local fixture](../experiments/issue-1/archive-rollback.sh) exercises import, first incremental publication, and rollback. To revert a real approved batch, check the current remote tip and revert only its publication commits and index markers, preserving earlier and unrelated commits. Verify the reverted revision is eligible again. Reverting preserves Git objects, so use the deployment's private incident procedure for sensitive material.
5. When the approved policy, incremental batch and rollback are verified, switch the scheduler to the absolute pinned executable with `archive-sessions --repo OWNER/REPO --publish-private OWNER/PRIVATE_ARCHIVE --limit 3` and the same source flags, one allowed source at a time. Keep overlap prevention, account, configuration and private logs in the deployment. Confirm an actual scheduled run and subsequent deduplication before retiring the old scheduler.

## Retire the previous entry points

For each row in the [inventory](case-studies/issue-1/README.md), record the actual caller, owning deployment, validated replacement command, observed live result, and fallback or rollback. Remove an old command only after the owner confirms there are no remaining callers and all of its required behaviors have an exercised replacement. Retain configuration and scheduling in the owning deployment. Keep shared legacy behavior here while a deployed workflow depends on it.
