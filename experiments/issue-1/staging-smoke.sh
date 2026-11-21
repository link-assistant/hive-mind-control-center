#!/usr/bin/env bash
# Run on an isolated Linux Docker daemon with the released hive-manager on PATH.
set -euo pipefail

manager=${1:-hive-manager}
[[ $("$manager" --version) == 2.45.0 ]]
[[ -S /var/run/docker.sock && $(docker context show) == default && -z ${DOCKER_HOST:-} ]] || exit 1

work=$(mktemp -d)
name=hive-manager-stage-$(printf '%s' "${work##*.}" | tr '[:upper:]' '[:lower:]')
image=$name:fixture
cleanup() {
  docker exec "$name-target" rm -rf -- "$work/stage state" "$work/restored" >/dev/null 2>&1 || :
  docker rm -f "$name-gateway" "$name-target" "$name" "$name.candidate" \
    "$name.previous" "$name.rollback" >/dev/null 2>&1 || :
  docker network rm "$name" >/dev/null 2>&1 || :
  docker image rm "$image" >/dev/null 2>&1 || :
  rm -rf -- "$work"
}
trap cleanup EXIT

docker build --tag "$image" - <<'DOCKERFILE'
FROM docker:29-cli@sha256:34507eb5069d8be82c95dd3b6987d4250fd5fee49b82e2509b7d7a7030740d6d AS cli
FROM debian:bookworm-slim@sha256:734a72b3d6142a71993b4bc580ca01d8ca687f77a2c422d96a961d3376b179bc
COPY --from=cli /usr/local/bin/docker /usr/local/bin/docker
RUN apt-get update && apt-get install -y --no-install-recommends openssh-server && \
    rm -rf /var/lib/apt/lists/* && mkdir -p /run/sshd && useradd --create-home box && \
    printf '#!/bin/sh\nprintf "fixture Hive Mind\\n"\n' >/usr/local/bin/hive && chmod +x /usr/local/bin/hive
DOCKERFILE

ssh-keygen -q -t ed25519 -N '' -f "$work/client"
docker network create "$name" >/dev/null
for server in gateway target; do
  ssh-keygen -q -t ed25519 -N '' -f "$work/$server"
  printf '%s %s\n' "$server" "$(cat "$work/$server.pub")" >> "$work/known_hosts"
  server_flags=()
  if [[ $server == gateway ]]; then
    server_flags=(--publish 127.0.0.1::22)
  else
    server_flags=(--mount "type=bind,source=$work,target=$work" --volume /var/run/docker.sock:/var/run/docker.sock)
  fi
  docker run -d --name "$name-$server" --network "$name" "${server_flags[@]}" \
    --mount "type=bind,source=$work/$server,target=/host-key,readonly" \
    --mount "type=bind,source=$work/client.pub,target=/fixture-authorized-keys,readonly" \
    "$image" sh -ec 'mkdir -m 700 -p /root/.ssh
      install -m 600 /fixture-authorized-keys /root/.ssh/authorized_keys
      exec /usr/sbin/sshd -D -e -h /host-key -o PermitRootLogin=prohibit-password \
        -o PasswordAuthentication=no -o KbdInteractiveAuthentication=no' >/dev/null
done

port=$(docker port "$name-gateway" 22/tcp)
cat > "$work/ssh.conf" <<EOF
Host gateway
  HostName 127.0.0.1
  Port ${port##*:}
  HostKeyAlias gateway
Host target
  HostName $name-target
  HostKeyAlias target
  ProxyJump gateway
Host *
  User root
  StrictHostKeyChecking yes
  UserKnownHostsFile $work/known_hosts
  IdentitiesOnly yes
  IdentityFile $work/client
  BatchMode yes
  ConnectTimeout 5
EOF
for ((attempt = 0; attempt < 5; attempt++)); do
  if ssh -F "$work/ssh.conf" target true; then break; fi
  sleep 1
done

cat > "$work/stage.conf" <<EOF
name=$name
variant=plain
image=$image
state-dir=stage state
EOF
remote=("$manager" --ssh-config "$work/ssh.conf" --host target deploy)
stage=("${remote[@]}" --profile "$work/stage.conf")
"${stage[@]}" --dry-run --setup apply
"${stage[@]}" --no-pull --setup apply
first=$(docker inspect --format '{{.Id}}' "$name")
"${stage[@]}" doctor
"${stage[@]}" diagnose --resources
"${stage[@]}" disk

"${stage[@]}" exec -- bash -c 'printf persisted > /home/box/.codex/probe'
"${stage[@]}" stop
(umask 077; "${stage[@]}" backup --output - > "$work/state.tar.gz")
"${remote[@]}" --state-dir "$work/restored" restore < "$work/state.tar.gz"
printf -v restore_probe '%q' "$work/restored/codex/probe"
[[ $(ssh -F "$work/ssh.conf" target "cat $restore_probe") == persisted ]]
if "${remote[@]}" --state-dir "$work/restored" restore < "$work/state.tar.gz"; then exit 1; fi
"${stage[@]}" start

"${stage[@]}" --no-pull --setup update
second=$(docker inspect --format '{{.Id}}' "$name")
[[ $first != "$second" ]]
[[ $("${stage[@]}" exec -- cat /home/box/.codex/probe) == persisted ]]
if "${stage[@]}" --no-pull update -- false; then exit 1; fi
[[ $(docker inspect --format '{{.Id}} {{.State.Status}}' "$name") == "$second running" ]]
"${stage[@]}" rollback
[[ $(docker inspect --format '{{.Id}} {{.State.Status}}' "$name") == "$first running" ]]

docker create --name "$name.candidate" --label "io.github.link-assistant.hive-manager.instance=$name" \
  --label "io.github.link-assistant.hive-manager.predecessor=$first" \
  --label io.github.link-assistant.hive-manager.predecessor-running=true "$image" false >/dev/null
docker stop "$name" >/dev/null
"${stage[@]}" recover
[[ $(docker inspect --format '{{.Id}} {{.State.Status}}' "$name") == "$first running" ]]
if docker inspect "$name.candidate" >/dev/null 2>&1; then exit 1; fi
[[ $("${stage[@]}" exec -- cat /home/box/.codex/probe) == persisted ]]
printf '%s\n' 'Pinned hive-manager staging smoke passed over OpenSSH ProxyJump'
