**Separate finding and required policy: Hive Mind's server must start Claude and Codex with zero globally installed add-ons. Playwright MCP is the only approved operator-installed default.** Skills/plugins/hooks requested for an individual task must be confined to that task; sharing auth and conversation history must never share mutable extension configuration.

The root container had a globally enabled Superpowers plugin, seven Caveman/Cavecrew skills, synced Claude skills and plugin state, cached Codex plugin/marketplace state, and an additional Codex MCP registration. Those violate the required baseline. The root deployment retains complete persisted tool directories, which allows old global extensions to survive redeployment. The currently running task's inspected configuration was scoped separately; the retained evidence does not establish that this particular task installed the root additions. Installation timestamps and cached directories alone cannot identify the historical writer.

**Cleanup and auto-fix work completed**

At the operator's request, removed the unapproved global extension state and registrations from the server. Original files/configs are quarantined outside tool discovery with restricted server-side access. Auth, conversation history, task scopes, model/provider settings and permissions were preserved. Both tools now register only Playwright MCP; global hooks are disabled, Codex remote plugin sync is disabled, and Claude official marketplace auto-registration is disabled.

The remaining Codex `.system` entries are stock skills supplied by the CLI itself, part of its out-of-box runtime. No operator-installed global skills remain. CI should compare that stock baseline against a pristine instance of the same pinned CLI version rather than treating arbitrary files under `.system` as automatically trusted.

The control-center auto-fix script now has a server-global baseline guard:

```sh
# Audit only; exit 1 if contaminated
node auto-fix.mjs --global-tools-only --dry-run

# Remove/quarantine unapproved global additions and reconcile configuration
node auto-fix.mjs --global-tools-only
```

Normal auto-fix recovery enforces this baseline before recovering tasks and checks it again on every monitor poll. Diagnostic mode reports it without modifying tool state. It checks global user/root and present system/managed config layers, removes installed extension payloads as well as registrations, filters non-Playwright MCPs, and rejects unsafe/unparseable or concurrently modified configuration. It never runs installed plugin or hook code to perform cleanup.

Fourteen safety/regression tests pass, covering auth/history preservation, task-scope preservation, config inode preservation, idempotence, read-only auditing, concurrent edits, malformed config, managed security-policy preservation, symlink/hard-link attempts to redirect cleanup into credentials, and redirected tool homes that would otherwise produce a false clean result. Independently checked the live server afterward: protected auth files and history directory identities match the pre-cleanup state, the active task was not restarted or reconfigured, local CLI checks recognize Playwright and Codex's stored ChatGPT login, and an audit after CLI startup returns zero findings. No model request was needed for these checks.

**How the isolation must work**

| Scope | Persistent/shared state | Configuration and extensions |
| --- | --- | --- |
| Host canonical store | Credentials and conversation evidence, including session/project/rollout files and required indexes | Never use a restored personal tool home or plugin cache as the default configuration template. |
| Root/bot container | Mount the canonical credentials/history; preserve them through deploys and cleanup | A minimal, validated global home: Playwright MCP only, no operator-installed skills, plugins, hooks, agents, commands or global instruction files. |
| Each task container | Resolve auth/history to the same canonical store under the previously stated auth-sharing contract | Fresh, separate tool configuration. Install only capabilities explicitly required for this task, into its own scope. No writable mount of the root's config, plugin/skill directories, marketplaces or caches. |

The launcher must validate the **effective** paths after applying tool-home variables, profiles, repository scopes and preflight. Setting a scoped home is insufficient if another search path still discovers global skills or plugins. Check alternate global locations, legacy command directories, enabled-plugin metadata, marketplace snapshots, cloud/synced payloads, inline hooks and hook manifests. An explicitly selected Router/alternative backend may use its own credential authority, as already agreed; it must not silently introduce globally installed client add-ons or relax conversation-audit retention.

Task requirement discovery/catalog materialization must also run in disposable task-owned storage. The current preflight's use of operator-global catalog state must not require installing a plugin globally merely to make it available to one task. Task installations must never write back to the root home or a mutable image/template reused by later tasks. Finished-task caches and recovery snapshots must not become future global defaults.

Preserve the separate auth requirement while changing mounts: do not copy rotating credentials into independent task homes. Verify the selected sharing mechanism against real CLI writes and atomic replacement; a single-file mount or symlink is not sufficient evidence by itself. If a shared credential directory or a supported credential-storage adapter is needed, isolate its contents from configuration and test it explicitly. Keep sessions/projects and the metadata required for discovery, resume and audit durable on the host.

Deployment must migrate old full-home state through an explicit allowlist, retaining auth/history and approved Playwright registration while excluding extension configuration/payloads. Validate the final packaged image and restored host state before admitting tasks. A contaminated root must fail launch/deploy validation; warning and continuing is not acceptable. Auto-fix provides repair, but its maintenance loop is not a substitute for enforcement inside Hive Mind's launcher.

**Required upstream CI/CD gates**

- Boot the actual release images and root container with fresh and previously contaminated persistent state. Check effective Claude/Codex configuration and discovered capabilities: only stock runtime content plus Playwright by default, with no enabled or installed global add-ons. Test startup again to catch automatic rehydration.
- Run two concurrent tasks with different explicitly requested capabilities. Verify each task sees only its allowed capabilities and that every root/global configuration surface remains clean during and after install, preflight, execution and completion.
- Attempt writes through each mounted/configured path, tool-home override, symlink and task recovery snapshot. A task must not mutate root/global extension state. Deliberately injected contamination must be detected and cleaned by auto-fix; malformed or unsafe state must fail validation.
- Verify that both tools still use canonical auth/history, including refresh, atomic replacement, restart/resume and cleanup. Confirm transcripts and required indexes persist without sharing plugin/configuration directories.
- Require these integration checks for release and deployment, including CLI upgrades and supported Docker-daemon layouts. Keep test data synthetic and avoid publishing credentials or conversation contents in CI logs.

The server cleanup and control-center auto-fix guard are implemented and verified. The structural launcher/image/deployment changes and their required upstream Docker CI gates remain implementation work for this issue; they are not claimed complete by the maintenance cleanup.
