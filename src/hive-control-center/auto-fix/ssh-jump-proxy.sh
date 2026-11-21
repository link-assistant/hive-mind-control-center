#!/bin/sh
# SSH ProxyCommand for reaching SERVER_IP through a password-authenticated jump
# host. OpenSSH invokes it with no arguments; the target and credentials come
# from the environment or .lenv. Passwords never appear on the command line.
set -eu

here=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
lenv=${LENV_FILE:-$here/../.lenv}

read_key() {
  key=$1
  [ -r "$lenv" ] || return 0
  awk -v key="$key" '
    index($0, key ":") == 1 {
      value = $0
      sub(/^[^:]*:[[:space:]]*/, "", value)
      sub(/[[:space:]]+$/, "", value)
      print value
      exit
    }
  ' "$lenv"
}

value() {
  name=$1
  fallback=$2
  eval "current=\${$name-}"
  if [ -n "${current:-}" ]; then
    printf '%s' "$current"
    return
  fi
  current=$(read_key "$name")
  if [ -n "$current" ]; then
    printf '%s' "$current"
  else
    printf '%s' "$fallback"
  fi
}

target_host=${PROXY_TARGET_HOST:-$(value SERVER_IP '')}
target_port=${PROXY_TARGET_PORT:-$(value SERVER_PORT 22)}
jump_host=$(value JUMP_HOST '')
jump_user=$(value JUMP_USER root)
jump_pass=$(value JUMP_PASS '')
jump_port=$(value JUMP_PORT 22)

[ -n "$target_host" ] || { echo "SSH jump proxy: SERVER_IP is not set" >&2; exit 1; }
[ -n "$jump_host" ] || { echo "SSH jump proxy: JUMP_HOST is not set" >&2; exit 1; }
[ -n "$jump_pass" ] || { echo "SSH jump proxy: JUMP_PASS is not set" >&2; exit 1; }

export SSHPASS="$jump_pass"
exec sshpass -e ssh \
  -o StrictHostKeyChecking=no \
  -o UserKnownHostsFile=/dev/null \
  -o LogLevel=ERROR \
  -o PubkeyAuthentication=no \
  -o PreferredAuthentications=password,keyboard-interactive \
  -o NumberOfPasswordPrompts=1 \
  -o ConnectTimeout=10 \
  -o TCPKeepAlive=yes \
  -p "$jump_port" \
  -W "$target_host:$target_port" \
  "$jump_user@$jump_host"
