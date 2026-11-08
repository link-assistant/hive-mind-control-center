# /workspace permissions research

## Root cause

In the hive-mind Dockerfile, Playwright's Chrome installation runs as root with `HOME=/workspace`:

```dockerfile
sudo env "PATH=$PATH" HOME=/workspace playwright install chrome
```

This creates `/workspace/.local/share/applications/mimeapps.list` as part of Chrome's desktop integration. Because it runs as root, the entire `/workspace/.local` tree is created with `root:sandbox` ownership and mode `2755` (no group write). This gets baked into the Docker image.

At runtime, when the sandbox user runs tools that need `/workspace/.local/share/` or `/workspace/.local/state/` (e.g. `bun install -g`, `agent`), they fail with:

```
EACCES: permission denied, mkdir '/workspace/.local/share/link-assistant-agent'
EACCES: permission denied, mkdir '/workspace/.local/state'
```

### Verification

```
$ docker run --rm konard/hive-mind:latest find /workspace/.local -ls
drwxr-sr-x  3 root sandbox 4096 /workspace/.local
drwxr-sr-x  3 root sandbox 4096 /workspace/.local/share
drwxr-sr-x  2 root sandbox 4096 /workspace/.local/share/applications
-rw-r--r--  1 root sandbox    0 /workspace/.local/share/applications/mimeapps.list
```

All owned by `root:sandbox` with mode `2755` — sandbox user cannot write.

### Why the build succeeds silently

The hive-mind Dockerfile uses `|| echo "..."` on every `bun install -g` command:

```dockerfile
RUN bun install -g @link-assistant/hive-mind || echo "hive-mind: not yet published"
```

Bun hits the EACCES error when trying to create directories under `/workspace/.local`, but the `|| echo` swallows the failure and the build continues.

### Cascading failures from silent errors

Because `/workspace/.local` is broken and errors are swallowed, other tools also fail at runtime. For example, Gemini CLI:

```
Gemini CLI: Failed to save project registry to /workspace/.gemini/projects.json:
Error: ENOENT: no such file or directory, rename '/workspace/.gemini/projects.json.tmp' -> '/workspace/.gemini/projects.json'
```

`/workspace/.gemini` doesn't exist in the image because Gemini CLI's installation failed silently during build (swallowed by `|| echo`). The binary gets installed but initialization never completes — bun hits the EACCES error on `/workspace/.local` first, preventing proper state tracking, and subsequent tool initialization steps fail as a cascade.

This worked in the previous image (sandbox ≤1.3.x) because HOME was `/home/hive`, fully owned by the hive user — no root-owned directories blocking anything. The migration to `/workspace` with the root-owned `/workspace/.local` broke the entire installation chain.

The `|| echo "..."` pattern in the hive-mind Dockerfile makes this invisible during build — any tool that needs `/workspace/.local` during installation silently fails.

## Proper fix (in sandbox/hive-mind Dockerfiles)

### 1. JS sandbox image (`ubuntu/24.04/js/Dockerfile`)

Move Playwright/Puppeteer system dependencies, CLI tools, and browser binary downloads here — all as `USER sandbox`, no sudo. This ensures `/workspace/.local` is created with correct ownership from the start.

Tracked in: https://github.com/link-foundation/sandbox/issues/74

### 2. Essentials sandbox (`ubuntu/24.04/essentials-sandbox/install.sh`)

Remove Playwright/Puppeteer system dependencies (~60 lines) and CLI installations — they move to the JS image. Essentials becomes focused on git, gh, glab, and git identity tools.

Tracked in: https://github.com/link-foundation/sandbox/issues/74

### 3. Full sandbox (`Dockerfile`)

After all `COPY --from` operations (which run as root), restore `/workspace` ownership:

```dockerfile
RUN chown sandbox:sandbox /workspace
```

Tracked in: https://github.com/link-foundation/sandbox/issues/74

### 4. Hive-mind Dockerfile

Eliminate `USER root` entirely. Once sandbox ships browsers pre-installed, the Dockerfile only needs AI-specific packages as `USER sandbox`.

Tracked in: https://github.com/link-assistant/hive-mind/issues/1505

## Temporary workaround (in deploy scripts)

Until the Dockerfiles are fixed, the deploy scripts (`deploy-docker.mjs`, `docker-restart-remotely.mjs`, `update-docker.mjs`) apply a runtime workaround before running `bun install -g`:

```bash
docker exec -u root $CONTAINER mkdir -p /workspace/.local/share /workspace/.local/state
docker exec -u root $CONTAINER chown -R sandbox:sandbox /workspace/.local
```

Gemini CLI needs to be run three times to fully initialize its config directory (`/workspace/.gemini`). The first run creates the directory and `projects.json`. The second run fails with `ENOENT` on `rename` of `projects.json.tmp` (a Gemini CLI bug — likely a race between cleanup and save). The third run succeeds cleanly:

```bash
docker exec $CONTAINER bash -l -c 'gemini --version'  # creates .gemini dir and projects.json
docker exec $CONTAINER bash -l -c 'gemini --version'  # fails: ENOENT on rename projects.json.tmp
docker exec $CONTAINER bash -l -c 'gemini --version'  # succeeds cleanly
```

Additionally, `docker cp` (which always writes files as root) requires a follow-up chown:

```bash
docker cp /tmp/start-bot.sh $CONTAINER:/workspace/start-bot.sh
docker exec -u root $CONTAINER chown sandbox:sandbox /workspace/start-bot.sh
```

## Other changes applied

- All scripts updated: `/home/hive` → `/workspace`, `--user hive` → `--user sandbox`, `hive:hive` → `sandbox:sandbox`, `su - hive` → `su - sandbox`
- Credential mount permission fixes retained (chown on `/root/.hive-mind/claude`, `/root/.hive-mind/gh`, `/root/.hive-mind/claude.json` to match sandbox user UID)
- Home directory ownership debug/fix steps removed (sandbox 1.5.0 owns `/workspace` by default)
