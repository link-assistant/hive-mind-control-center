# Migrate Control Center operations to Hive Mind Manager

Use Hive Mind **2.45.0** for the staging exercise. Keep the SSH configuration, profiles, credentials, active-task records, incident routes, and scheduler with the deployment that owns them. The [command inventory and verification record](case-studies/issue-1/README.md) lists the release gaps and the requirements for moving each live caller.

## Prepare the operator and staging host

Install the pinned CLI in a private operator directory. Using that copy for remote commands sends the installed manager script over OpenSSH.

```bash
umask 077
npm install --prefix "$HOME/.local/hive-manager-2.45.0" --omit=optional @link-assistant/hive-mind@2.45.0
manager="$HOME/.local/hive-manager-2.45.0/node_modules/.bin/hive-manager"
"$manager" --version
```

Expect `2.45.0`. The [release documentation](https://github.com/link-assistant/hive-mind/blob/v2.45.0/docs/deployment/hive-manager.md) describes the commands and authentication. If Docker or Telegram tests run from another machine, use the same release there.

Call the pinned executable from automation. The package currently exposes the CLI. The requested public JavaScript interface is tracked upstream. [Manager library](https://github.com/link-assistant/hive-mind/issues/4116)

Copy [staging.conf](../examples/hive-manager/staging.conf) to a new profile directory on the target through the existing SSH alias. The profile uses the pinned plain image, a distinct name, and a state directory relative to the profile. Verify host keys, the configured jump chain, capacity to pull the image, and permission to use Docker and read its service journal. With the deployment's actual staging alias and remote profile path, run:

```bash
stage_host=hive-staging
stage_profile=./hive-manager-stage/staging.conf
stage=("$manager" --host "$stage_host" deploy --profile "$stage_profile")

ssh "$stage_host" true
"${stage[@]}" --dry-run --setup apply
"${stage[@]}" docker-service status
"${stage[@]}" doctor
"${stage[@]}" prepare
"${stage[@]}" --setup apply
"${stage[@]}" status
"${stage[@]}" doctor
"${stage[@]}" diagnose --since '1 hour ago' --resources
"${stage[@]}" disk
```

The setup container runs without a Telegram bot token. Record the SSH route, Docker daemon ID, image digest, container ID, and resolved mounts in a private operator log. Inspect diagnostic results for missing permissions or unavailable data. Keep any test bot token and allowlist in a separate staging environment file readable by the deployment account.

### Prove backup, update, rollback, and interrupted-update recovery

Create a harmless marker inside a staging state mount, then take an application-consistent backup. Back up any separately mounted config or Docker volumes with the deployment's existing procedure. Keep the local archive and restored directory private.

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

Run the following with the deployment's actual `--host` and `--profile`. First preview and save output in the deployment's private log.

| Workflow                    | Manager entry point                                                                                                        | Check before moving the caller                                                                                                                                                                                                                                                                                                             |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Disk and daemon diagnostics | `deploy disk`, `deploy doctor`, `deploy diagnose --since '1 hour ago' --resources`                                         | Keep the per-task legacy disk report for writable layers, paused tasks, and host-directory attribution.                                                                                                                                                                                                                                    |
| Routine cleanup             | `deploy cleanup --dry-run`                                                                                                 | Inspect candidates in the bot's own environment. Use legacy guarded cleanup for protected host paths, targeted task layers, or memory pressure. The manager's `--docker` mode requests a host-wide prune.                                                                                                                                  |
| Failed-task retention       | `deploy tasks backup-container CONTAINER --output NEW_DIRECTORY`, then `deploy tasks cleanup-backed-up NEW_DIRECTORY`      | Confirm stopped-container identity and the approval digest. Preserve mounted data, execution records and logs separately. Run the removal with `--apply DIGEST` only after verifying the private backup and its independent evidence.                                                                                                      |
| Active tasks and watchers   | `deploy tasks list --running`, `deploy tasks status UUID`, `deploy tasks attach UUID --read-only`                          | Compare each active or paused task to the same Docker daemon, container ID, execution UUID, attempt and existing watcher. Capture another baseline after the update before repairing anything.                                                                                                                                             |
| Reconciliation and recovery | `deploy tasks repair-records UUID`, `deploy tasks recover-failed`                                                          | Verify their previews against running state. Apply a supported record repair with `--apply` only for the expected detached attempt. Use `deploy tasks resume-all` to reconcile records already marked executing after checking active families. Keep the fallback for alias exit 127, eligible later retries, and writable-layer headroom. |
| Incident publication        | `deploy tasks report --group`, `deploy tasks report --collect UUID --attempt N`, `deploy diagnose --task UUID --attempt N` | Correlate known attempts with their log offsets, daemon journal, and historical route before previewing a post.                                                                                                                                                                                                                            |

Use `deploy tasks check-uploads` for stalled uploads. Check the deployment's same-user CPU and I/O thresholds and verify the process identity. `--terminate PID` requires an explicit PID and current evidence.

For an incident, place the deployment's reviewed route file where the command runs and preview `deploy tasks report --incident UUID --attempt N --destination OWNER/REPO --routes FILE`. Review the backend, failure kind, exit code, signature and selected issue, and compare the legacy ledger and issue comments for a duplicate. Use `--host-signature` only when the corresponding attempt's time window supports the diagnosis. An unmatched failure previews a new issue. Closed issue routes require the legacy version-aware review until ledger and routing parity is available. Pass `--publish REVIEW_DIGEST` only for the reviewed destination and evidence.

To recover the bot queue, retain verbose logs from before and after the restart, both including queue initialization. Run locally on those files:

```bash
"$manager" tasks recover-queue --previous previous.log --current current.log
```

Confirm each candidate is absent from the live queue and active task records. If raw commands are needed, use `--include-commands` in a private terminal. Check dependencies, sandbox settings and authorized chat with the request owner. Resubmit each confirmed lost request once through that chat, then record its new task ID or queue entry and verify its status.

## MTProxy maintenance and client checks

Keep the deployment's existing proxy port, name, image, secret, workers, connection limits, and installed MSS rules in the private baseline. The documented legacy classic setup uses 443, four workers, an MSS of 1200, and a nofile limit of 524288. Check these values on the target before selecting a replacement. The 8443 candidate must have a separate name and state.

Inspect state with `deploy proxy --proxy-name NAME --port PORT status` and `verify`. Use `snapshot` and `compare` once the state has a manager-owned secret. Preserve the legacy snapshot while the existing proxy is untouched. The manager's `verify` tries Telegram DCs from the deployment host. Check egress from the running proxy's network namespace separately. Review `mss-unit` output against the installed rules before changing them. Use `apply` for a separate staging proxy in an authorized window. For an exact-name cutover, `--adopt` before `proxy` authorizes `update` on the legacy container. On first creation or replacement, the manager imports `--secret-file` if its proxy state has no saved secret. `apply` on an existing container simply ensures it is started. A successful `update` removes its predecessor, so preserve the original image digest, secret, and launch settings in the legacy rollback procedure before updating.

For an individually managed proxy, `deploy proxy --proxy-name NAME --port PORT stop` pauses it and `remove` removes its container while preserving the secret. Use the [legacy undeploy runbook](../src/hive-control-center/docs/DEPLOY.md#removing-or-temporarily-stopping-the-proxy) when the deployment needs to sweep old container names and disable or remove the installed legacy MSS hook. [Multi-container and MSS gap](https://github.com/link-assistant/hive-mind/issues/4111#issuecomment-7060642659)

Run the client probes **from the affected network** with a dedicated, authorized account. Store the Telegram API credentials JSON, preauthorized StringSession, proxy secret, and a deterministic harmless photo in a private test directory. Run both controls using the pinned client release:

```bash
probe=("$manager" proxy-test --credentials ./telegram-api.json --session-file ./test.session)
"${probe[@]}" --direct --media --photo ./probe.png
"${probe[@]}" --proxy-host "$proxy_host" --proxy-port "$proxy_port" \
  --secret-file ./mtproxy.secret --media --photo ./probe.png
```

Check text, exact document bytes, and decoded photo dimensions and content using the existing known-good test. Record the network, timestamp, release, port, candidate configuration, and results without secrets or raw captures. Use the legacy matrix and rollback procedure when two candidates must take turns on one port. The manager's `--matrix` can compare routes that are up simultaneously. Keep the existing client checks until the pinned proxy passes both text and media from the affected network. [Legacy MTProxy verification](../src/hive-control-center/docs/MTProxy-VERIFICATION.md)

## Move the private archive scheduler

1. Identify the active schedule, account, exact source paths, source repository allowlist, attachment and LINO settings, and private redaction inputs. Pause the scheduler in its owning deployment and check that no publisher is running. Keep a copy of its configuration and the existing archive's Git tip. Verify the destination is private, its default branch exists, the scheduler account has push access, and the account has access to the intended inactive sources. Preserve the existing destination, branch, and history.
2. Before allowing a push, resolve the legacy revision-index and known-secrets gaps. The 2.45.0 native index cannot identify already archived legacy revisions by their old SHA-256 metadata. Carry over source directories using `--claude-dir` and `--codex-dir`. Review the need for `--lino`, `--tool-results`, the age policy, large-file omissions, and the legacy archive summary. Run previews as the existing scheduler account in an unshared directory with `umask 077` and the pinned manager. Stage one bounded, intended source with the existing output policy. `NEW_REVIEW_DIRECTORY` must not exist.

   ```bash
   gh repo view "$archive" --json visibility,viewerPermission,defaultBranchRef
   "$manager" archive-sessions --repo "$source_repo" --published-in "$archive" \
     --output "$review_dir" --limit 1
   "$manager" archive-publish "$review_dir" --destination "$archive"
   ```

   Inspect the manifest, every staged file, the destination and review digest. Use the current private redaction/exclusion checks and confirm the revision was never published under the legacy flow. When the bounded incremental batch is authorized, recheck privacy and scheduler pause, then run `archive-publish` again with `--apply REVIEW_DIGEST`. Verify the commit is a descendant of the recorded tip, the diff contains exactly the reviewed additions, and the subsequent preview skips the published revision.

3. With the scheduler still paused, test the rollback on an isolated private archive with the same history shape. The [local rollback experiment](../experiments/issue-1/archive-rollback.sh) exercises this with a disposable Git remote. For a real approved batch rollback, check current remote tip first. Revert only the exact publication commits, including their index additions, from a clone of the current default branch, then verify older Git history and archive paths remain. Use a fresh preview to confirm the reverted revision is eligible again before deciding whether to resume the scheduler. Keep the archive private. A revert leaves Git objects containing the original publication in history, so use the deployment's private incident procedure for any sensitive material.
4. Once the first incremental batch and rollback are proven and the existing policy is supported, change the scheduler to use the absolute pinned executable with `archive-sessions --repo OWNER/REPO --publish-private OWNER/PRIVATE_ARCHIVE --limit 3`, one permitted source at a time. Keep overlap prevention, owner account, private logs, and approved export flags in the deployment. Confirm an actual scheduled run and subsequent deduplication before retiring the previous schedule.

See the [legacy archive runbook](../src/hive-control-center/docs/archive-public-sessions.md) for its behavior and exclusion policy.

## Retire the previous entry points

For each row in the [inventory](case-studies/issue-1/README.md), record the actual caller, owning deployment, validated replacement command, observed live result, and fallback or rollback. Remove an old command only after the owner confirms there are no remaining callers and all of its required behaviors have an exercised replacement. Retain configuration and scheduling in the owning deployment. Keep shared legacy behavior here while a deployed workflow depends on it.
