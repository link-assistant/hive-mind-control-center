#!/usr/bin/env bash
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LENV_FILE="${LENV_FILE:-$SCRIPT_DIR/.lenv}"
PORT="${MTPROXY_PORT:-443}"
CONTAINER="${MTPROXY_CONTAINER:-mtproxy-classic-${PORT}}"
CAPTURE=0
CAPTURE_SECONDS="${MTPROXY_CAPTURE_SECONDS:-20}"
CLIENT_IP="${MTPROXY_CLIENT_IP:-}"
KEEP_PCAP=0
RESTART_TELEGRAM=0
STRICT=0
NO_REPORT=0
MEDIA_SECONDS="${MTPROXY_MEDIA_SECONDS:-8}"
REPORT_DIR="${MTPROXY_REPORT_DIR:-$SCRIPT_DIR/data/diagnostics}"

usage() {
  cat <<'EOF'
Usage: ./diagnose-mtproxy.sh [options]

Read-only diagnostics for the MTProto proxy and the local Telegram client.
The only temporary change is an optional tcpdump capture on the server.

Options:
  --port <port>          Proxy port (default: 443 or MTPROXY_PORT)
  --container <name>     Proxy container (default: mtproxy or MTPROXY_CONTAINER)
  --capture              Capture traffic on the server for 20s. Reconnect Telegram when prompted.
  --capture-seconds <n>  Capture duration (default: 20)
  --client-ip <ip>       Restrict pcap analysis to one client IP
  --keep-pcap            Keep the remote pcap and print its path
  --restart-telegram     Quit/reopen Telegram automatically before capturing
  --strict               Exit non-zero on hard failures (missing port/MSS/config)
  --no-report            Do not write a timestamped report under data/diagnostics/
  --media-seconds <n>    Sample media files for n seconds (default: 8; 0 disables)
  --lenv <path>          Path to .lenv (default: ./.lenv)
  -h, --help             Show this help

Environment overrides: MTPROXY_PORT, MTPROXY_CONTAINER, MTPROXY_CLIENT_IP,
MTPROXY_CAPTURE_SECONDS, MTPROXY_MEDIA_SECONDS, MTPROXY_REPORT_DIR, LENV_FILE.

Default container is mtproxy-classic-<port>; the remote check also falls back to
mtproxy if that classic container does not exist.
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --port) PORT="${2:-}"; shift 2 ;;
    --container) CONTAINER="${2:-}"; shift 2 ;;
    --capture) CAPTURE=1; shift ;;
    --capture-seconds) CAPTURE_SECONDS="${2:-}"; shift 2 ;;
    --client-ip) CLIENT_IP="${2:-}"; shift 2 ;;
    --keep-pcap) KEEP_PCAP=1; shift ;;
    --restart-telegram) RESTART_TELEGRAM=1; shift ;;
    --strict) STRICT=1; shift ;;
    --no-report) NO_REPORT=1; shift ;;
    --media-seconds) MEDIA_SECONDS="${2:-}"; shift 2 ;;
    --report-dir) REPORT_DIR="${2:-}"; shift 2 ;;
    --lenv) LENV_FILE="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

if ! [[ "$PORT" =~ ^[0-9]+$ ]] || [ "$PORT" -lt 1 ] || [ "$PORT" -gt 65535 ]; then
  echo "ERROR: invalid --port: $PORT" >&2
  exit 2
fi
if ! [[ "$CAPTURE_SECONDS" =~ ^[0-9]+$ ]] || [ "$CAPTURE_SECONDS" -lt 5 ]; then
  echo "ERROR: invalid --capture-seconds: $CAPTURE_SECONDS" >&2
  exit 2
fi
if ! [[ "$MEDIA_SECONDS" =~ ^[0-9]+$ ]] || [ "$MEDIA_SECONDS" -lt 0 ] || [ "$MEDIA_SECONDS" -gt 120 ]; then
  echo "ERROR: invalid --media-seconds: $MEDIA_SECONDS" >&2
  exit 2
fi
if [ ! -r "$LENV_FILE" ]; then
  echo "ERROR: cannot read $LENV_FILE" >&2
  exit 2
fi
if ! command -v sshpass >/dev/null 2>&1; then
  echo "ERROR: sshpass is required (brew install hudochenkov/sshpass/sshpass)." >&2
  exit 2
fi

lenv_get() {
  local key="$1" line value
  line="$(grep -m1 -E "^[[:space:]]*${key}[[:space:]]*[:=]" "$LENV_FILE" 2>/dev/null)" || return 1
  value="${line#*[:=]}"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  value="${value%$'\r'}"
  value="${value#\"}"; value="${value%\"}"
  value="${value#\'}"; value="${value%\'}"
  printf '%s' "$value"
}

SERVER_IP="$(lenv_get SERVER_IP || true)"
SERVER_USER="$(lenv_get SERVER_USER || true)"
SERVER_PASS="$(lenv_get SERVER_PASS || true)"
SERVER_USER="${SERVER_USER:-root}"

if [ -z "$SERVER_IP" ] || [ -z "$SERVER_PASS" ]; then
  echo "ERROR: SERVER_IP and SERVER_PASS must be set in $LENV_FILE" >&2
  exit 2
fi

REPORT_FILE=""
if [ "$NO_REPORT" != "1" ]; then
  mkdir -p "$REPORT_DIR"
  REPORT_FILE="$REPORT_DIR/mtproxy-$(date +%Y%m%d-%H%M%S).log"
  exec > >(tee -a "$REPORT_FILE") 2>&1
  printf 'report: %s\n' "$REPORT_FILE"
fi

SSH_OPTS=(
  -o StrictHostKeyChecking=no
  -o UserKnownHostsFile=/dev/null
  -o ConnectTimeout=15
  -o LogLevel=ERROR
  -o PubkeyAuthentication=no
  -o PreferredAuthentications=password
)

remote() {
  sshpass -p "$SERVER_PASS" ssh "${SSH_OPTS[@]}" "$SERVER_USER@$SERVER_IP" "$@"
}

section() {
  printf '\n== %s ==\n' "$1"
}

note() {
  printf '%s\n' "$*"
}

LOCAL_SENDQ=0
LOCAL_ESTAB=0
LOCAL_SENDQ_MAX=0
LOCAL_RECVQ_MAX=0
PUBLIC_IP=""
APP_PROXY_STATUS="unknown"
APP_PROXY_HOST=""
APP_PROXY_PORT=""
APP_SECRET_PREFIX=""
APP_SECRET_SHA=""
PROXY_SECRET_SHA=""
APP_NO_RESPONSE=0
APP_NO_RESPONSE_TOTAL=0
APP_RESUMES=0
APP_LOG_PATH=""
APP_LOG_BASELINE=0
MEDIA_DIR=""
MEDIA_PARTIAL=0
MEDIA_PARTIAL_BYTES=0
MEDIA_RECENT=0
MEDIA_GROWTH=0
REMOTE_OUTPUT=""
REMOTE_CLIENT=0
REMOTE_DC=0
REMOTE_OTHER443=0
REMOTE_SENDQ_MAX=0
REMOTE_STALLED=0
REMOTE_NO_PAYLOAD=0
REMOTE_ACTIVE=0
REMOTE_CLIENT_BYTES_RECV=0
REMOTE_CLIENT_BYTES_SENT=0
REMOTE_CONTAINER=""
REMOTE_PID=""
REMOTE_LISTENING=0
REMOTE_MSS_RULES=0
REMOTE_DC2_MAIN=0
REMOTE_DC2_MAIN_ACTIVE=0
PROXY_TYPE=""
LOG_CLIENTHELLO_ERRORS=0
CAPTURE_OUTPUT=""
CAPTURE_CLIENT_BYTES=0
CAPTURE_PROXY_BYTES=0
CAPTURE_CLIENT_CONNS=0
CAPTURE_MSS=""

local_public_ip() {
  PUBLIC_IP="$(curl -4 -fsS --max-time 5 https://api.ipify.org 2>/dev/null || true)"
}

local_app_config() {
  local group cfg parsed
  group="$HOME/Library/Group Containers/6N38VWS5BX.ru.keepcoder.Telegram/appstore"
  cfg="$group/accounts-shared-data"
  if [ ! -r "$cfg" ]; then
    APP_PROXY_STATUS="missing-config"
    return 0
  fi
  if ! command -v node >/dev/null 2>&1; then
    APP_PROXY_STATUS="node-missing"
    return 0
  fi
  parsed="$(node "$SCRIPT_DIR/scripts/mtproxy/app-config.mjs" "$cfg" 2>/dev/null || true)"
  APP_PROXY_STATUS="$(printf '%s\n' "$parsed" | sed -n 's/^status=//p' | head -1)"
  APP_PROXY_HOST="$(printf '%s\n' "$parsed" | sed -n 's/^host=//p' | head -1)"
  APP_PROXY_PORT="$(printf '%s\n' "$parsed" | sed -n 's/^port=//p' | head -1)"
  APP_SECRET_PREFIX="$(printf '%s\n' "$parsed" | sed -n 's/^prefix=//p' | head -1)"
  APP_SECRET_SHA="$(printf '%s\n' "$parsed" | sed -n 's/^sha=//p' | head -1)"
  if [ "$APP_PROXY_STATUS" = "ok" ] && [ "$APP_PROXY_HOST" = "$SERVER_IP" ] && [ "$APP_PROXY_PORT" = "$PORT" ]; then
    APP_PROXY_STATUS="match"
  elif [ "$APP_PROXY_STATUS" = "ok" ]; then
    APP_PROXY_STATUS="mismatch"
  fi
}

local_app_logs() {
  local group logs latest
  group="$HOME/Library/Group Containers/6N38VWS5BX.ru.keepcoder.Telegram/appstore"
  logs="$group/logs"
  [ -d "$logs" ] || return 0
  latest="$(ls -t "$logs"/critlog-*.txt 2>/dev/null | head -1 || true)"
  [ -n "$latest" ] || return 0
  APP_LOG_PATH="$latest"
  APP_LOG_BASELINE="$(stat -f %z "$latest" 2>/dev/null || stat -c %s "$latest" 2>/dev/null || echo 0)"
  APP_NO_RESPONSE_TOTAL="$(grep -aciE 'no response|invalidating the transport|connection.*stuck' "$latest" 2>/dev/null || true)"
  APP_RESUMES="$(tail -400 "$latest" 2>/dev/null | grep -ciE 'resume|reconnect|transport.*restart' || true)"
  APP_NO_RESPONSE_TOTAL="${APP_NO_RESPONSE_TOTAL:-0}"
  APP_RESUMES="${APP_RESUMES:-0}"
}

local_app_log_delta() {
  [ -n "$APP_LOG_PATH" ] && [ -f "$APP_LOG_PATH" ] || return 0
  local baseline="${APP_LOG_BASELINE:-0}"
  APP_NO_RESPONSE="$(tail -c +"$((baseline + 1))" "$APP_LOG_PATH" 2>/dev/null | strings -a 2>/dev/null | grep -ciE 'no response|invalidating the transport|connection.*stuck' || true)"
  APP_NO_RESPONSE="${APP_NO_RESPONSE:-0}"
}

media_snapshot() {
  local dir="$1" partial bytes recent
  if [ -z "$dir" ] || [ ! -d "$dir" ]; then
    printf '0 0 0'
    return 0
  fi
  partial="$(find "$dir" -maxdepth 3 -type f \( -name '*_partial*' -o -name '*.partial' \) 2>/dev/null | wc -l | tr -d ' ')"
  if [ "$(uname -s)" = "Darwin" ]; then
    bytes="$(find "$dir" -maxdepth 3 -type f \( -name '*_partial*' -o -name '*.partial' \) -exec stat -f %z {} + 2>/dev/null | awk '{s+=$1} END{print s+0}')"
  else
    bytes="$(find "$dir" -maxdepth 3 -type f \( -name '*_partial*' -o -name '*.partial' \) -exec stat -c %s {} + 2>/dev/null | awk '{s+=$1} END{print s+0}')"
  fi
  recent="$(find "$dir" -maxdepth 3 -type f -mmin -30 -size +100k ! -name '*_partial*' ! -name '*.partial' 2>/dev/null | wc -l | tr -d ' ')"
  printf '%s %s %s' "$partial" "${bytes:-0}" "$recent"
}

local_media_check() {
  local group candidates after after_bytes
  group="$HOME/Library/Group Containers/6N38VWS5BX.ru.keepcoder.Telegram/appstore"
  [ -d "$group" ] || return 0
  MEDIA_DIR="$(find "$group" -maxdepth 2 -type d -name media 2>/dev/null | head -1 || true)"
  [ -n "$MEDIA_DIR" ] || return 0
  candidates="$(media_snapshot "$MEDIA_DIR")"
  MEDIA_PARTIAL="$(printf '%s' "$candidates" | awk '{print $1}')"
  MEDIA_PARTIAL_BYTES="$(printf '%s' "$candidates" | awk '{print $2}')"
  MEDIA_RECENT="$(printf '%s' "$candidates" | awk '{print $3}')"
  [ "$MEDIA_SECONDS" -gt 0 ] || return 0
  sleep "$MEDIA_SECONDS"
  after="$(media_snapshot "$MEDIA_DIR")"
  after_bytes="$(printf '%s' "$after" | awk '{print $2}')"
  MEDIA_GROWTH=$((after_bytes - MEDIA_PARTIAL_BYTES))
}

local_checks() {
  section "Local path"
  if [ -n "$PUBLIC_IP" ]; then
    note "public ip: $PUBLIC_IP"
  else
    note "public ip: unavailable"
  fi
  note "server: $SERVER_IP"
  note "proxy:  $SERVER_IP:$PORT"
  if command -v sw_vers >/dev/null 2>&1; then
    note "os:     $(sw_vers -productName) $(sw_vers -productVersion)"
  else
    note "os:     $(uname -srm)"
  fi

  local iface local_ip mtu
  if command -v route >/dev/null 2>&1 && route -n get default >/dev/null 2>&1; then
    iface="$(route -n get default 2>/dev/null | awk '/interface:/{print $2; exit}')"
  else
    iface="$(ip route show default 2>/dev/null | awk '/default/{print $5; exit}')"
  fi
  if [ -n "${iface:-}" ]; then
    note "default interface: $iface"
    if command -v ifconfig >/dev/null 2>&1; then
      local_ip="$(ifconfig "$iface" 2>/dev/null | awk '/inet /{print $2; exit}')"
      mtu="$(ifconfig "$iface" 2>/dev/null | awk '/mtu /{print $NF; exit}')"
    else
      local_ip="$(ip -4 addr show dev "$iface" 2>/dev/null | awk '/inet /{sub(/\/.*/,"",$2); print $2; exit}')"
      mtu="$(ip link show dev "$iface" 2>/dev/null | awk '/mtu/{for(i=1;i<=NF;i++) if($i=="mtu") print $(i+1); exit}')"
    fi
    note "local ip: ${local_ip:-unknown}"
    note "local mtu: ${mtu:-unknown}"
  fi

  section "Local Telegram client"
  pgrep -fl 'Telegram' 2>/dev/null || note "Telegram process not found"
  if [ -d /Applications/Telegram.app ]; then
    note "bundle: $(mdls -name kMDItemCFBundleIdentifier -r /Applications/Telegram.app 2>/dev/null || echo unknown)"
  fi
  note "app proxy status: $APP_PROXY_STATUS"
  note "app proxy host:   ${APP_PROXY_HOST:-unknown}"
  note "app proxy port:   ${APP_PROXY_PORT:-unknown}"
  note "app secret prefix: ${APP_SECRET_PREFIX:-unknown}"
  if [ -n "$APP_SECRET_SHA" ]; then
    note "app secret sha256: $APP_SECRET_SHA"
  fi
  if [ -n "$APP_LOG_PATH" ]; then
    note "app log: $APP_LOG_PATH"
    note "app no-response lines (historical): $APP_NO_RESPONSE_TOTAL"
    note "app resume/reconnect lines (last 400): $APP_RESUMES"
  fi

  section "Local media"
  if [ -n "$MEDIA_DIR" ]; then
    note "media dir: $MEDIA_DIR"
    note "partial files: $MEDIA_PARTIAL (${MEDIA_PARTIAL_BYTES} bytes)"
    note "recent completed files (30m): $MEDIA_RECENT"
    note "partial growth over ${MEDIA_SECONDS}s: $MEDIA_GROWTH bytes"
  else
    note "media dir not found"
  fi

  section "Local sockets to proxy"
  local sockets
  if command -v netstat >/dev/null 2>&1; then
    sockets="$(netstat -anv -p tcp 2>/dev/null | grep -E "[.]$PORT[[:space:]]" | grep "$SERVER_IP" || true)"
  else
    sockets="$(ss -tnp 2>/dev/null | grep -E "[:.]$PORT[[:space:]]" | grep "$SERVER_IP" || true)"
  fi
  if [ -z "$sockets" ]; then
    note "no local TCP sockets to $SERVER_IP:$PORT"
  else
    printf '%s\n' "$sockets" | head -40
    if [ "$(uname -s)" = "Darwin" ]; then
      LOCAL_ESTAB="$(printf '%s\n' "$sockets" | awk '$6 == "ESTABLISHED" {c++} END{print c+0}')"
      LOCAL_SENDQ_MAX="$(printf '%s\n' "$sockets" | awk '$6 == "ESTABLISHED" {if ($3+0 > m) m=$3+0} END{print m+0}')"
      LOCAL_RECVQ_MAX="$(printf '%s\n' "$sockets" | awk '$6 == "ESTABLISHED" {if ($2+0 > m) m=$2+0} END{print m+0}')"
    else
      LOCAL_ESTAB="$(printf '%s\n' "$sockets" | awk '$1 == "ESTAB" {c++} END{print c+0}')"
      LOCAL_SENDQ_MAX="$(printf '%s\n' "$sockets" | awk '$1 == "ESTAB" {if ($3+0 > m) m=$3+0} END{print m+0}')"
      LOCAL_RECVQ_MAX="$(printf '%s\n' "$sockets" | awk '$1 == "ESTAB" {if ($2+0 > m) m=$2+0} END{print m+0}')"
    fi
    note "established sockets: $LOCAL_ESTAB; max Send-Q: $LOCAL_SENDQ_MAX; max Recv-Q: $LOCAL_RECVQ_MAX"
    if [ "$LOCAL_SENDQ_MAX" -gt 0 ]; then
      LOCAL_SENDQ=1
      note "INFO: local Send-Q is non-zero on established connections (normal during active transfer; compare with remote payload metrics)."
    fi
  fi

  section "Proxy TCP reachability"
  if command -v nc >/dev/null 2>&1; then
    local nc_timeout=-w
    [ "$(uname -s)" = "Darwin" ] && nc_timeout=-G
    if nc -vz "$nc_timeout" 5 "$SERVER_IP" "$PORT" >/dev/null 2>&1; then
      note "PASS: TCP $SERVER_IP:$PORT is reachable"
    else
      note "FAIL: TCP $SERVER_IP:$PORT is not reachable"
    fi
  else
    note "SKIP: nc not found"
  fi

  section "Direct Telegram DC reachability"
  local dc
  for dc in 149.154.167.41:443 91.108.56.130:443 149.154.175.50:443; do
    if command -v nc >/dev/null 2>&1; then
      local nc_timeout=-w
      [ "$(uname -s)" = "Darwin" ] && nc_timeout=-G
      if nc -vz "$nc_timeout" 5 "${dc%:*}" "${dc#*:}" >/dev/null 2>&1; then
        note "PASS: direct $dc"
      else
        note "FAIL: direct $dc"
      fi
    fi
  done

  section "Path MTU to proxy"
  local size max_ok=""
  for size in 1472 1464 1450 1440 1420 1400 1380 1300 1200 1100; do
    if [ "$(uname -s)" = "Darwin" ]; then
      ping -D -s "$size" -c 2 -W 1000 "$SERVER_IP" >/dev/null 2>&1 && ok=1 || ok=0
    else
      ping -M do -s "$size" -c 2 -W 1 "$SERVER_IP" >/dev/null 2>&1 && ok=1 || ok=0
    fi
    if [ "$ok" = "1" ]; then
      note "PASS: payload $size (MTU $((size + 28)))"
      if [ -z "$max_ok" ]; then max_ok="$size"; fi
    else
      note "FAIL: payload $size (MTU $((size + 28)))"
    fi
  done
  if [ -n "$max_ok" ]; then
    note "max working IPv4 payload: $max_ok (MTU $((max_ok + 28)))"
    if [ "$max_ok" -lt 1472 ]; then
      note "WARN: path MTU is below 1500; large TLS ClientHello segments may be dropped."
    fi
  else
    note "FAIL: no tested payload size succeeded"
  fi
}

remote_summary() {
  section "Remote proxy"
  remote "PORT='$PORT' CONTAINER='$CONTAINER' bash -s" <<'REMOTE'
set -u
echo "host: $(hostname)"
echo "date: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
if [ -r /etc/os-release ]; then . /etc/os-release; echo "os: ${PRETTY_NAME:-unknown}"; fi

if ! docker inspect "$CONTAINER" >/dev/null 2>&1; then
  for candidate in "mtproxy-classic-$PORT" "mtproxy"; do
    if docker inspect "$candidate" >/dev/null 2>&1; then
      CONTAINER="$candidate"
      break
    fi
  done
fi
if ! docker inspect "$CONTAINER" >/dev/null 2>&1; then
  echo "container: MISSING ($CONTAINER)"
  echo "container_effective=$CONTAINER"
  exit 0
fi

echo "container: $(docker ps -a --filter "name=^${CONTAINER}$" --format '{{.Status}} ports={{.Ports}}')"
echo "container_effective=$CONTAINER"
IMAGE="$(docker inspect -f '{{.Config.Image}}' "$CONTAINER")"
echo "image: $IMAGE"
echo "restarts: $(docker inspect -f '{{.RestartCount}}' "$CONTAINER")"
echo "restart_policy=$(docker inspect -f '{{.HostConfig.RestartPolicy.Name}}' "$CONTAINER")"
echo "network_mode=$(docker inspect -f '{{.HostConfig.NetworkMode}}' "$CONTAINER")"
echo "container_running=$(docker inspect -f '{{.State.Running}}' "$CONTAINER")"
PID="$(docker inspect -f '{{.State.Pid}}' "$CONTAINER" 2>/dev/null || true)"
echo "pid=${PID:-unknown}"

SECRET_FILE="$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Source}}{{end}}{{end}}' "$CONTAINER" 2>/dev/null || true)"
PROXY_SECRET_SHA=""
if [ -n "$SECRET_FILE" ] && [ -r "$SECRET_FILE/secret" ]; then
  PROXY_SECRET_SHA="$(tr -d ' \r\n' < "$SECRET_FILE/secret" | sha256sum | cut -d' ' -f1)"
elif [ -n "$PID" ] && [ "$PID" != "0" ]; then
  PROXY_SECRET_SHA="$(docker exec "$CONTAINER" sh -c 'cat /data/secret 2>/dev/null' 2>/dev/null | tr -d ' \r\n' | sha256sum | cut -d' ' -f1)"
fi
echo "proxy_secret_sha256=${PROXY_SECRET_SHA:-unknown}"
echo "port_listening=$(ss -ltnH 2>/dev/null | grep -cE "[:.]$PORT[[:space:]]" || true)"
echo "mss_rule_count=$(( $(iptables -t mangle -S 2>/dev/null | grep -ci mss || true) + $(iptables -S 2>/dev/null | grep -ci mss || true) ))"
echo "mss_service=$(systemctl is-enabled mtproxy-mss.service 2>/dev/null || true),$(systemctl is-active mtproxy-mss.service 2>/dev/null || true)"
CONF_FILE="$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Source}}{{end}}{{end}}' "$CONTAINER" 2>/dev/null || true)/proxy.conf"
if [ -r "$CONF_FILE" ]; then
  echo "proxy_dc2_main=$(grep -c '^proxy_for 2 149\.154\.161\.144:8888;' "$CONF_FILE" 2>/dev/null || true)"
  echo "proxy_dc2_media=$(grep -c '^proxy_for -2 149\.154\.161\.184:8888;' "$CONF_FILE" 2>/dev/null || true)"
  echo "proxy_media203=$(grep -c '^proxy_for -203 91\.105\.192\.110:443;' "$CONF_FILE" 2>/dev/null || true)"
else
  echo "proxy_dc2_main=0"
  echo "proxy_dc2_media=0"
  echo "proxy_media203=0"
fi

case "$IMAGE" in
  *mtg*) PROXY_TYPE="mtg" ;;
  *) PROXY_TYPE="mtproto-proxy/classic" ;;
esac

echo
echo "-- proxy type --"
echo "$PROXY_TYPE"

echo
echo "-- recent logs --"
docker logs --since 15m "$CONTAINER" 2>&1 | tail -120 | sed -E 's/(secret[[:space:]]*[=:][[:space:]]*)[^[:space:]]+/\1REDACTED/Ig' || true

echo
echo "-- container sockets --"
if [ -n "${PID:-}" ] && [ "$PID" != "0" ]; then
  nsenter -t "$PID" -n ss -tnp 2>/dev/null | head -200 || true
else
  echo "no container pid"
fi

echo
echo "-- socket summary --"
if [ -n "${PID:-}" ] && [ "$PID" != "0" ]; then
  nsenter -t "$PID" -n ss -tn 2>/dev/null | awk -v port="$PORT" '
    $1 == "ESTAB" {
      local = $4
      peer = $5
      sendq = $3 + 0
      if (local ~ ":" port "$") {
        client++
        if (sendq > maxsendq) maxsendq = sendq
        if (sendq > 100000) stalled++
      }
      if (peer ~ /149[.]154[.]|91[.]108[.]|2001:67c:4e8/) dc++
      if (peer ~ /:443$/ && peer !~ /149[.]154[.]|91[.]108[.]|2001:67c:4e8/) other443++
    }
    END { printf "client_connections=%d telegram_dc_connections=%d other_443=%d server_sendq_max=%d stalled_client_connections=%d\n", client, dc, other443, maxsendq, stalled }
  '
fi

echo
echo "-- dc2 main upstream (text path) --"
if [ -n "${PID:-}" ] && [ "$PID" != "0" ]; then
  nsenter -t "$PID" -n ss -tinH state established "( dport = :8888 )" 2>/dev/null > /tmp/mtproxy-ss-dc.txt || true
  DC2_CONNS="$(grep -c '149\.154\.161\.144:8888' /tmp/mtproxy-ss-dc.txt 2>/dev/null || true)"
  DC2_ACTIVE="$(grep -A1 '149\.154\.161\.144:8888' /tmp/mtproxy-ss-dc.txt 2>/dev/null | grep -o 'bytes_sent:[0-9]*' | awk -F: '$2+0 > 92 {c++} END {print c+0}')"
  echo "dc2_main_connections=${DC2_CONNS:-0} dc2_main_active=${DC2_ACTIVE:-0}"
fi

echo
echo "-- host sockets on port --"
ss -tn 2>/dev/null | grep -E "[:.]$PORT[[:space:]]" || true

echo
echo "-- TCPMSS rules --"
iptables -t mangle -S 2>/dev/null | grep -i mss || true
iptables -S 2>/dev/null | grep -i mss || true
nft list ruleset 2>/dev/null | grep -i mss || true

echo
echo "-- mtg doctor --"
if [ "$PROXY_TYPE" = "mtg" ]; then
  docker exec "$CONTAINER" /mtg doctor /config.toml 2>&1 | tail -100 || true
else
  echo "not applicable (classic mtproto-proxy)"
fi
REMOTE
}

CAPTURE_PATH=""

start_capture() {
  section "Packet capture"
  note "Starting a ${CAPTURE_SECONDS}s tcpdump on the server; reconnect Telegram after the prompt."
  local output
  output="$(remote "PORT='$PORT' SECONDS='$CAPTURE_SECONDS' bash -s" <<'REMOTE'
set -u
CAP="/tmp/mtproxy-diagnose-$(date +%s).pcap"
rm -f /tmp/mtproxy-diagnose-last.path
nohup timeout "$SECONDS" tcpdump -i any -nn -s0 -U -w "$CAP" "tcp port $PORT" >/tmp/mtproxy-diagnose-tcpdump.log 2>&1 &
printf '%s\n' "$CAP" > /tmp/mtproxy-diagnose-last.path
echo "$CAP"
sleep 1
if kill -0 $! 2>/dev/null; then echo "CAPTURE_STARTED"; else echo "CAPTURE_FAILED"; cat /tmp/mtproxy-diagnose-tcpdump.log; fi
REMOTE
)"
  printf '%s\n' "$output"
  if ! printf '%s\n' "$output" | grep -q CAPTURE_STARTED; then
    note "FAIL: could not start tcpdump."
    return 1
  fi
  CAPTURE_PATH="$(printf '%s\n' "$output" | grep '^/tmp/' | head -1)"
  note ""
  if [ "$RESTART_TELEGRAM" = "1" ] && [ "$(uname -s)" = "Darwin" ]; then
    note "Restarting Telegram to generate fresh proxy connections..."
    osascript -e 'quit app "Telegram"' >/dev/null 2>&1 || pkill -x Telegram >/dev/null 2>&1 || true
    sleep 2
    open -a Telegram >/dev/null 2>&1 || true
    sleep 2
  else
    note ">>> Reconnect Telegram now. Use the proxy settings, toggle the proxy off/on, or restart Telegram. <<<"
  fi
  note "Capturing for ${CAPTURE_SECONDS}s..."
  sleep "$CAPTURE_SECONDS"
  note "Analyzing $CAPTURE_PATH"
  analyze_capture "$CAPTURE_PATH"
}

analyze_capture() {
  local cap="$1" out client_arg="" client_ip="$CLIENT_IP"
  if ! command -v node >/dev/null 2>&1; then
    note "FAIL: node is required to analyze the capture."
    return 1
  fi
  [ -n "$client_ip" ] || client_ip="$PUBLIC_IP"
  if [ -n "$client_ip" ]; then client_arg="--client $client_ip"; fi
  out="$(remote "cat '$cap'" 2>/dev/null | node "$SCRIPT_DIR/scripts/mtproxy/pcap.mjs" --port "$PORT" $client_arg 2>&1 || true)"
  CAPTURE_OUTPUT="$out"
  printf '%s\n' "$out"
  capture_field() {
    printf '%s\n' "$out" | sed -n "s/^$1=//p" | head -1
  }
  CAPTURE_CLIENT_BYTES="$(capture_field CAPTURE_CLIENT_BYTES)"
  CAPTURE_PROXY_BYTES="$(capture_field CAPTURE_PROXY_BYTES)"
  CAPTURE_CLIENT_CONNS="$(capture_field CAPTURE_CLIENT_CONNS)"
  CAPTURE_MSS="$(capture_field CAPTURE_MSS)"
  CAPTURE_CLIENT_BYTES="${CAPTURE_CLIENT_BYTES:-0}"
  CAPTURE_PROXY_BYTES="${CAPTURE_PROXY_BYTES:-0}"
  CAPTURE_CLIENT_CONNS="${CAPTURE_CLIENT_CONNS:-0}"
}
cleanup_capture() {
  local cap="$1"
  [ "$KEEP_PCAP" = "1" ] && return 0
  remote "rm -f '$cap' /tmp/mtproxy-diagnose-last.path" >/dev/null 2>&1 || true
}

local_public_ip
local_app_config
local_app_logs
local_media_check
local_checks
REMOTE_OUTPUT="$(remote_summary || true)"
printf '%s\n' "$REMOTE_OUTPUT"

metric() {
  printf '%s\n' "$REMOTE_OUTPUT" | grep -o "$1=[0-9]*" | head -1 | cut -d= -f2
}
metric_str() {
  printf '%s\n' "$REMOTE_OUTPUT" | sed -n "s/^$1=//p" | head -1
}
REMOTE_CLIENT="$(metric client_connections)"
REMOTE_DC="$(metric telegram_dc_connections)"
REMOTE_OTHER443="$(metric other_443)"
REMOTE_SENDQ_MAX="$(metric server_sendq_max)"
REMOTE_STALLED="$(metric stalled_client_connections)"
REMOTE_NO_PAYLOAD="$(metric client_no_payload)"
REMOTE_ACTIVE="$(metric client_active)"
REMOTE_CLIENT_BYTES_RECV="$(metric client_bytes_received)"
REMOTE_CLIENT_BYTES_SENT="$(metric client_bytes_sent)"
REMOTE_CONTAINER="$(metric_str container_effective)"
REMOTE_LISTENING="$(metric port_listening)"
REMOTE_MSS_RULES="$(metric mss_rule_count)"
REMOTE_DC2_MAIN="$(metric dc2_main_connections)"
REMOTE_DC2_MAIN_ACTIVE="$(metric dc2_main_active)"
PROXY_SECRET_SHA="$(metric_str proxy_secret_sha256)"
PROXY_TYPE="$(printf '%s\n' "$REMOTE_OUTPUT" | awk '/^-- proxy type --$/{getline; print; exit}')"
LOG_CLIENTHELLO_ERRORS="$(printf '%s\n' "$REMOTE_OUTPUT" | grep -c 'cannot read client hello' || true)"
REMOTE_CLIENT="${REMOTE_CLIENT:-0}"
REMOTE_DC="${REMOTE_DC:-0}"
REMOTE_OTHER443="${REMOTE_OTHER443:-0}"
REMOTE_SENDQ_MAX="${REMOTE_SENDQ_MAX:-0}"
REMOTE_STALLED="${REMOTE_STALLED:-0}"
REMOTE_NO_PAYLOAD="${REMOTE_NO_PAYLOAD:-0}"
REMOTE_ACTIVE="${REMOTE_ACTIVE:-0}"
REMOTE_CLIENT_BYTES_RECV="${REMOTE_CLIENT_BYTES_RECV:-0}"
REMOTE_CLIENT_BYTES_SENT="${REMOTE_CLIENT_BYTES_SENT:-0}"
REMOTE_LISTENING="${REMOTE_LISTENING:-0}"
REMOTE_MSS_RULES="${REMOTE_MSS_RULES:-0}"
REMOTE_DC2_MAIN="${REMOTE_DC2_MAIN:-0}"
REMOTE_DC2_MAIN_ACTIVE="${REMOTE_DC2_MAIN_ACTIVE:-0}"
LOG_CLIENTHELLO_ERRORS="${LOG_CLIENTHELLO_ERRORS:-0}"
[ -n "$REMOTE_CONTAINER" ] || REMOTE_CONTAINER="$CONTAINER"
REMOTE_PID="$(metric_str pid)"

if command -v node >/dev/null 2>&1 && [ -n "$REMOTE_PID" ] && [ "$REMOTE_PID" != "unknown" ] && [ "$REMOTE_PID" != "0" ]; then
  SS_TIN="$(remote "nsenter -t '$REMOTE_PID' -n ss -tinH state established 2>/dev/null" || true)"
  SOCKET_SUMMARY="$(printf '%s\n' "$SS_TIN" | node "$SCRIPT_DIR/scripts/mtproxy/ss-tin.mjs" --port "$PORT" 2>/dev/null || true)"
  if [ -n "$SOCKET_SUMMARY" ]; then
    printf '\n-- socket payload summary --\n%s\n' "$SOCKET_SUMMARY"
    REMOTE_OUTPUT="${REMOTE_OUTPUT}
${SOCKET_SUMMARY}"
    socket_field() {
      printf '%s\n' "$SOCKET_SUMMARY" | tr ' ' '\n' | sed -n "s/^$1=//p" | head -1
    }
    REMOTE_NO_PAYLOAD="$(socket_field client_no_payload)"
    REMOTE_ACTIVE="$(socket_field client_active)"
    REMOTE_CLIENT_BYTES_RECV="$(socket_field client_bytes_received)"
    REMOTE_CLIENT_BYTES_SENT="$(socket_field client_bytes_sent)"
    REMOTE_NO_PAYLOAD="${REMOTE_NO_PAYLOAD:-0}"
    REMOTE_ACTIVE="${REMOTE_ACTIVE:-0}"
    REMOTE_CLIENT_BYTES_RECV="${REMOTE_CLIENT_BYTES_RECV:-0}"
    REMOTE_CLIENT_BYTES_SENT="${REMOTE_CLIENT_BYTES_SENT:-0}"
  fi
fi

if [ "$CAPTURE" = "1" ]; then
  start_capture || true
  if [ -n "$CAPTURE_PATH" ]; then
    cleanup_capture "$CAPTURE_PATH"
  fi
fi

local_app_log_delta

section "Verdict"
if [ -z "$REMOTE_OUTPUT" ]; then
  note "FAIL: remote diagnostics returned no output."
elif [ "$PROXY_TYPE" = "mtg" ]; then
  if [ "$REMOTE_DC" -gt 0 ] && [ "$REMOTE_CLIENT" -gt 0 ]; then
    note "PASS: mtg has client connections and Telegram DC connections."
  else
    note "FAIL: mtg has client=$REMOTE_CLIENT dc=$REMOTE_DC; FakeTLS traffic is not reaching Telegram."
    if [ "$LOG_CLIENTHELLO_ERRORS" -gt 0 ]; then
      note "      mtg logged $LOG_CLIENTHELLO_ERRORS failed ClientHello reads in the last 15m."
    fi
    note "      Use the classic mtproto-proxy path (dd secret) or capture with --capture."
  fi
else
  if [ "$REMOTE_DC" -gt 0 ]; then
    note "PASS: classic mtproto-proxy has $REMOTE_DC Telegram DC connections (client=$REMOTE_CLIENT)."
  elif [ "$REMOTE_CLIENT" -gt 0 ]; then
    note "WARN: client connections exist but no Telegram DC connections; proxy upstream may be blocked."
  else
    note "WARN: no client connections seen; reconnect Telegram or verify the link/port."
  fi
fi
if [ "$LOCAL_SENDQ" = "1" ] && [ "$REMOTE_DC" -eq 0 ]; then
  note "WARN: local Send-Q is non-zero and the proxy has no Telegram DC connections; data is stalling."
fi
if [ "$REMOTE_OTHER443" -gt 0 ]; then
  note "INFO: $REMOTE_OTHER443 outbound connection(s) to port 443 (fronting or other traffic)."
fi
if [ "$REMOTE_SENDQ_MAX" -gt 100000 ]; then
  note "FAIL: proxy has up to $REMOTE_SENDQ_MAX bytes queued to clients ($REMOTE_STALLED stalled connections)."
  note "      This usually means the server's packets are larger than the client path MTU (PMTU blackhole)."
  note "      Clamp MSS for the proxy port to 1360 and reconnect the client."
fi

section "Automated checks"
note "container: ${REMOTE_CONTAINER:-unknown} listening=$REMOTE_LISTENING mss_rules=$REMOTE_MSS_RULES"
note "client conns: $REMOTE_CLIENT (active=$REMOTE_ACTIVE no_payload=$REMOTE_NO_PAYLOAD) dc=$REMOTE_DC"
note "client bytes: received=$REMOTE_CLIENT_BYTES_RECV sent=$REMOTE_CLIENT_BYTES_SENT server_sendq_max=$REMOTE_SENDQ_MAX"
note "text path (dc2 main): connections=$REMOTE_DC2_MAIN payload_carrying=$REMOTE_DC2_MAIN_ACTIVE"
note "app proxy: $APP_PROXY_STATUS (prefix=${APP_SECRET_PREFIX:-unknown})"
if [ -n "$APP_SECRET_SHA" ] && [ -n "$PROXY_SECRET_SHA" ] && [ "$PROXY_SECRET_SHA" != "unknown" ]; then
  if [ "$APP_SECRET_SHA" = "$PROXY_SECRET_SHA" ]; then
    note "app secret matches proxy secret: yes"
  else
    note "app secret matches proxy secret: NO (app=$APP_SECRET_SHA proxy=$PROXY_SECRET_SHA)"
  fi
fi
note "app log: new_no_response=$APP_NO_RESPONSE historical_no_response=$APP_NO_RESPONSE_TOTAL resumes=$APP_RESUMES"
note "media: partial=$MEDIA_PARTIAL partial_bytes=$MEDIA_PARTIAL_BYTES growth=${MEDIA_GROWTH}B recent_complete=$MEDIA_RECENT"
if [ "$CAPTURE" = "1" ]; then
  note "capture: client_bytes=$CAPTURE_CLIENT_BYTES proxy_bytes=$CAPTURE_PROXY_BYTES client_conns=$CAPTURE_CLIENT_CONNS mss=${CAPTURE_MSS:-?}"
fi

FAIL=0
hard_fail() { note "FAIL: $*"; FAIL=1; }
if printf '%s\n' "$REMOTE_OUTPUT" | grep -q 'container: MISSING'; then
  hard_fail "proxy container is missing."
fi
if [ "$REMOTE_LISTENING" = "0" ]; then
  hard_fail "host port $PORT is not listening."
fi
if [ "$REMOTE_MSS_RULES" = "0" ]; then
  hard_fail "no TCPMSS rules found; large packets may be blackholed."
fi
if [ "$APP_PROXY_STATUS" = "mismatch" ]; then
  hard_fail "Telegram app proxy does not match $SERVER_IP:$PORT."
fi
if [ "$APP_PROXY_STATUS" = "match" ] && [ -n "$PROXY_SECRET_SHA" ] && [ "$PROXY_SECRET_SHA" != "unknown" ] && [ "$APP_SECRET_SHA" != "$PROXY_SECRET_SHA" ]; then
  hard_fail "Telegram app secret does not match the proxy's /data/secret."
fi
if [ "$REMOTE_CLIENT" -gt 0 ] && [ "$REMOTE_DC" -eq 0 ]; then
  hard_fail "clients connect but the proxy has no Telegram DC connections."
fi
if [ "$PROXY_TYPE" != "mtg" ] && [ "$REMOTE_CLIENT" -gt 0 ]; then
  if [ "$REMOTE_DC2_MAIN" -eq 0 ]; then
    hard_fail "no upstream connection to DC2 main (149.154.161.144:8888); text messages cannot flow."
  elif [ "$REMOTE_DC2_MAIN_ACTIVE" -eq 0 ]; then
    note "WARN: DC2 main upstream exists but no connection has carried payload yet; send a text to test."
  else
    note "PASS: DC2 main (text path) has $REMOTE_DC2_MAIN_ACTIVE payload-carrying upstream connection(s)."
  fi
fi
if [ "$REMOTE_NO_PAYLOAD" -gt 0 ] && [ "$REMOTE_ACTIVE" -eq 0 ]; then
  if [ "$CAPTURE" = "1" ] && [ "$CAPTURE_CLIENT_BYTES" -gt 0 ]; then
    note "WARN: the socket snapshot was taken before fresh connections sent data; the packet capture proves payload flow."
  else
    hard_fail "all client connections are handshake-only; no client payload is reaching the proxy."
  fi
fi
if [ "$REMOTE_SENDQ_MAX" -gt 100000 ]; then
  if [ "$REMOTE_ACTIVE" -gt 0 ] || { [ "$CAPTURE" = "1" ] && [ "$CAPTURE_PROXY_BYTES" -gt 0 ]; }; then
    note "WARN: $REMOTE_SENDQ_MAX bytes were queued on a few connections while other connections carry payload; watch for a real PMTU stall."
  else
    hard_fail "proxy has $REMOTE_SENDQ_MAX bytes queued to clients (PMTU/proxy stall)."
  fi
fi
if [ "$CAPTURE" = "1" ]; then
  if [ "$CAPTURE_CLIENT_BYTES" -eq 0 ] && [ "$CAPTURE_CLIENT_CONNS" -gt 0 ]; then
    hard_fail "capture shows handshakes but zero client payload."
  elif [ "$CAPTURE_CLIENT_BYTES" -ge 64 ] && [ "$CAPTURE_PROXY_BYTES" -eq 0 ]; then
    hard_fail "capture shows client payload but zero proxy response."
  elif [ "$CAPTURE_CLIENT_BYTES" -gt 0 ] && [ "$CAPTURE_CLIENT_BYTES" -lt 64 ]; then
    note "INFO: capture only saw a ${CAPTURE_CLIENT_BYTES}-byte probe; use --restart-telegram for a real handshake."
  fi
fi
if [ "$APP_NO_RESPONSE" -gt 0 ]; then
  note "WARN: app log gained $APP_NO_RESPONSE 'no response/invalidating' line(s) during this run."
else
  note "PASS: no new app transport errors were logged during this run."
fi
if [ "$MEDIA_GROWTH" -gt 0 ]; then
  note "PASS: partial media is growing ($MEDIA_GROWTH bytes in ${MEDIA_SECONDS}s)."
elif [ "$MEDIA_RECENT" -gt 0 ]; then
  note "PASS: $MEDIA_RECENT completed media file(s) in the last 30m."
fi

section "Result"
if [ "$FAIL" -eq 0 ]; then
  note "PASS: automated checks found no hard failures."
else
  note "FAIL: automated checks found one or more hard failures (see above)."
fi
if [ "$STRICT" = "1" ] && [ "$FAIL" -ne 0 ]; then
  note "Report: ${REPORT_FILE:-disabled}"
  exit 1
fi
note "Report: ${REPORT_FILE:-disabled}"
note "Use --capture --restart-telegram for a hands-off packet-level check."
