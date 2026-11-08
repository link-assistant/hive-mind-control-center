# Requirements and remaining work

This is the durable checklist for the operational tooling in this directory.
Update it whenever a requirement is added, changed, or completed.

## Repository and source policy

- [x] Upload all operational logic and scripts to `link-assistant/hive-mind-control-center`.
- [x] Keep source under `src/hive-control-center/`.
- [x] Keep private runtime data out of git: `.lenv`, `.env`, sessions, logs, captures, generated reports, snapshots.
- [x] Provide `.lenv.example` and document every runtime input.
- [x] Never print or commit Telegram API hashes, bot tokens, proxy secrets, SSH passwords, or session strings.
- [x] Use `.mjs` for new logic and checks; do not add Python.
- [x] Convert the remaining project `.sh` scripts to `.mjs`; `update-docker.sh` was retired because `update-docker.mjs` already covers it.
- [x] Keep experiments in the repository rather than temporary folders.
- [x] Make behavior configurable at execution time; private values come from environment or CLI paths.

## MTProto proxy

- [x] Use the classic `mtproto-proxy` engine as the production path.
- [x] Keep the verified known-good profile in `scripts/mtproxy/known-good.json`.
- [x] Store only the secret hash, never the secret, in the known-good profile.
- [x] Persist the proxy secret in `/data/secret`; do not rely on a `SECRET` environment variable.
- [x] Apply TCP MSS 1200 to ports `443` and `8443` in both directions.
- [x] Record the verified classic proxy configuration and recovery steps in `docs/DEPLOY.md`.
- [x] Keep text messages working end to end under normal use; verified through the MTProto API.
- [ ] Keep photos, video, documents, and avatars working end to end; a document is verified through the API, but photo/video/avatar transfers are not yet tested.
- [ ] Explain or mitigate the large idle client-connection count and occasional stalled send queues.

## Diagnostics and verification

- [x] Provide automated diagnostics with timestamped reports.
- [x] Compare the live deployment against the known-good profile automatically.
- [x] Record app proxy/secret match, listening port, MSS rules, DC connections, app-log deltas, and media progress.
- [x] Provide packet-capture based verification with a clear idle/probe verdict.
- [x] Avoid treating an idle client with no payload as a hard failure when capture proves flow.
- [x] Move the remaining shell diagnostics to `.mjs` and keep the shell-free path as the default.
- [ ] Add CI-safe syntax and behavior tests for the imported mjs diagnostics.
- [x] Add a `--help` contract and argument validation for the mjs diagnostics entry point.

## API-based testing

- [x] Test Telegram text delivery through the proxy with the MTProto API, not the visual app.
- [x] Provide `scripts/mtproxy/api-test.mjs` using a GramJS-compatible session.
- [x] Send a unique marker to Saved Messages, read it back, and print only status lines.
- [x] Accept API credentials, session path, proxy host, port, and secret at execution time.
- [x] Wire the API test into the main mjs diagnostics command.
- [x] Verify media through the API as well as text; `--api-media` uploads, downloads, and compares a document.

## Documentation and follow-up

- [x] Document the classic deployment, MSS clamp, known-good snapshot, and recovery paths.
- [x] Document the source-IP blackhole and stale-transport recovery.
- [x] Update the public gist after text and media are re-verified: `MTProxy-VERIFICATION.md` was added and `update-docker.sh` was removed.
- [x] Update `link-assistant/router#786` with the final evidence and repeatable commands: https://github.com/link-assistant/router/issues/786#issuecomment-6720729516
- [x] Record any remaining diagnosis in this file before stopping.

## Verification log

- 2026-11-08: `--api-test` passed (`API_TEST_CONNECTED=yes user=@drakonard`, marker verified and deleted).
- 2026-11-08: `--api-media` passed (68-byte document uploaded, downloaded, SHA-256 matched, and deleted).
- 2026-11-08: capture with API traffic passed (`CAPTURE_CLIENT_BYTES=8262`, `CAPTURE_PROXY_BYTES=11901`, `CAPTURE_CLIENT_CONNS=2`).
- 2026-11-08: known-good comparison passed with 15 checks and 0 mismatches.
- 2026-11-08: idle connections remain high (about 1105-1131 clients, 12 active, most with no payload); root cause is still open.
- 2026-11-08: repeated SSH probes from the same client IP began hanging while ping and TCP 22/443 stayed open, matching the documented source-IP blackhole; switching networks restores SSH. This blocked a final live rerun after the last cosmetic mjs change.
