#!/usr/bin/env bash
# Run on an isolated Linux Docker daemon. Pass the installed 2.48.0 package directory.
set -euo pipefail

package=$(realpath "${1:?Expected the installed Hive Mind 2.48.0 package directory}")
[[ $(node -p 'require(process.argv[1]).version' "$package/package.json") == 2.48.0 ]]
[[ -S /var/run/docker.sock && $(docker context show) == default && -z ${DOCKER_HOST:-} ]] || exit 1

work=$(mktemp -d)
name=hive-task-mounts-$(printf '%s' "${work##*.}" | tr '[:upper:]' '[:lower:]')
image=$name:fixture
cleanup() {
  docker rm -f "$name" "$name-task" >/dev/null 2>&1 || :
  docker image rm "$image" >/dev/null 2>&1 || :
  rm -rf -- "$work"
}
trap cleanup EXIT

docker build --tag "$image" - <<'DOCKERFILE'
FROM docker:29-cli@sha256:34507eb5069d8be82c95dd3b6987d4250fd5fee49b82e2509b7d7a7030740d6d AS cli
FROM node:24-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54
COPY --from=cli /usr/local/bin/docker /usr/local/bin/docker
DOCKERFILE

mkdir -p "$work"/{codex,git,hive}
printf '%s\n' codex-fixture > "$work/codex/auth.json"
printf '%s\n' git-fixture > "$work/git/config"
printf '%s\n' transient-fixture > "$work/hive/transient"
daemon=$(docker info --format '{{.ID}}')

docker run --rm --interactive --name "$name" --network none \
  --volume /var/run/docker.sock:/var/run/docker.sock \
  --mount "type=bind,source=$package/src,target=/fixture-manager,readonly" \
  --mount "type=bind,source=$work/codex,target=/home/box/.codex" \
  --mount "type=bind,source=$work/git,target=/home/box/.config/git" \
  --mount "type=bind,source=$work/hive,target=/home/box/.hive-mind" \
  "$image" node --input-type=module - "$image" "$name-task" "$work" "$daemon" <<'JS'
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { resolveDockerIsolationMountSources } from '/fixture-manager/docker-mount-namespace.lib.mjs';

const [image, task, host, daemon] = process.argv.slice(2);
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8' }).trim();
assert.equal(docker('info', '--format', '{{.ID}}'), daemon);
const mounts = [
  { source: '/home/box/.codex/auth.json', target: '/evidence/auth' },
  { source: '/home/box/.config/git/config', target: '/evidence/git' },
  { source: '/home/box/.hive-mind/transient', target: '/evidence/transient' },
];
const resolved = await resolveDockerIsolationMountSources({ mounts, image });
assert.deepEqual(resolved.map(({ source }) => source), [
  `${host}/codex/auth.json`,
  `${host}/git/config`,
  `${host}/hive/transient`,
]);
const bindings = resolved.flatMap(({ source, target }) => [
  '--mount', `type=bind,source=${source},target=${target},readonly`,
]);
assert.equal(
  docker('run', '--rm', '--name', task, '--network', 'none', ...bindings, image,
    'cat', ...mounts.map(({ target }) => target)),
  'codex-fixture\ngit-fixture\ntransient-fixture'
);
writeFileSync('/tmp/unbacked', 'fixture');
await assert.rejects(
  resolveDockerIsolationMountSources({
    mounts: [{ source: '/tmp/unbacked', target: '/evidence/unbacked' }],
    image,
  }),
  /mount backing could not be verified/
);
console.log('The released resolver mapped three bind-backed sources to the same host daemon and refused an unbacked source.');
JS
