#!/usr/bin/env bash
# Persistent, idempotent WireGuard + Clawd Relay installer.

set -euo pipefail
export LANG=C LC_ALL=C
umask 077

WG_PORT="${WG_PORT:-51820}"
WG_SUBNET="${WG_SUBNET:-10.8.0.0/24}"
RELAY_PORT="${RELAY_PORT:-7891}"
FORCE_PHONE_KEY="${FORCE_PHONE_KEY:-0}"
NODE_MIN_MAJOR=18
NODE_RELEASE="v22.17.0"

IFACE="clawd"
WG_DIR="/etc/wireguard"
WG_KEY_DIR="/etc/wireguard/clawd"
WG_CONF="/etc/wireguard/clawd.conf"
RELAY_ROOT="/opt/clawd-relay"
APP_DIR="/opt/clawd-relay/app"
NODE_RUNTIME_DIR="/opt/clawd-relay/node"
RELAY_ETC="/etc/clawd-relay"
RELAY_ENV="/etc/clawd-relay/relay.env"
UNIT="/etc/systemd/system/clawd-relay.service"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"

SUBNET_BASE="${WG_SUBNET%.*/*}"
SERVER_IP="${SUBNET_BASE}.1"
PC_IP="${SUBNET_BASE}.2"
PHONE_IP="${SUBNET_BASE}.3"

log() { printf '[wg-relay] %s\n' "$*" >&2; }
die() { log "ERROR: $2"; exit "$1"; }

SUDO=""
if [ "$(id -u)" -ne 0 ]; then
  if command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then
    SUDO="sudo"
  else
    die 13 "need root or passwordless sudo"
  fi
fi

command -v systemctl >/dev/null 2>&1 || die 15 "systemd is required"
[ -d /run/systemd/system ] || die 15 "systemd is not running"

PKG=""
if command -v apt-get >/dev/null 2>&1; then
  PKG="apt"
elif command -v dnf >/dev/null 2>&1; then
  PKG="dnf"
elif command -v yum >/dev/null 2>&1; then
  PKG="yum"
else
  die 10 "supported package manager required (apt/dnf/yum)"
fi

$SUDO mkdir -p "${RELAY_ROOT}" "${RELAY_ETC}" "${WG_DIR}"
$SUDO chmod 700 "${RELAY_ETC}" "${WG_DIR}"
BACKUP_DIR="$($SUDO mktemp -d /var/tmp/clawd-relay-backup.XXXXXX)"
$SUDO chmod 700 "${BACKUP_DIR}"
COMMITTED=0

backup_item() {
  local source="$1" name="$2"
  if $SUDO test -e "${source}"; then
    $SUDO cp -a "${source}" "${BACKUP_DIR}/${name}"
    $SUDO touch "${BACKUP_DIR}/${name}.present"
  fi
}

restore_item() {
  local destination="$1" name="$2"
  $SUDO rm -rf "${destination}"
  if $SUDO test -e "${BACKUP_DIR}/${name}.present"; then
    $SUDO cp -a "${BACKUP_DIR}/${name}" "${destination}"
  fi
}

backup_item "${APP_DIR}" app
backup_item "${NODE_RUNTIME_DIR}" node
backup_item "${WG_KEY_DIR}" keys
backup_item "${WG_CONF}" wg-conf
backup_item "${RELAY_ENV}" relay-env
backup_item "${UNIT}" relay-unit

rollback_on_exit() {
  local status=$?
  if [ "${status}" -ne 0 ] && [ "${COMMITTED}" -ne 1 ]; then
    set +e
    log "restoring previous Relay installation"
    restore_item "${APP_DIR}" app
    restore_item "${NODE_RUNTIME_DIR}" node
    restore_item "${WG_KEY_DIR}" keys
    restore_item "${WG_CONF}" wg-conf
    restore_item "${RELAY_ENV}" relay-env
    restore_item "${UNIT}" relay-unit
    $SUDO systemctl daemon-reload >/dev/null 2>&1
    $SUDO systemctl restart "wg-quick@${IFACE}" >/dev/null 2>&1
    $SUDO systemctl restart clawd-relay.service >/dev/null 2>&1
  fi
  $SUDO rm -rf "${BACKUP_DIR}"
  exit "${status}"
}
trap rollback_on_exit EXIT

log "step: install-system-dependencies"
case "${PKG}" in
  apt)
    $SUDO apt-get update -y -qq || die 10 "apt-get update failed"
    $SUDO env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq wireguard-tools curl ca-certificates tar coreutils openssl || die 10 "apt install failed"
    ;;
  dnf)
    $SUDO dnf install -y -q wireguard-tools curl ca-certificates tar coreutils openssl || die 10 "dnf install failed"
    ;;
  yum)
    $SUDO yum install -y -q epel-release || die 10 "yum epel install failed"
    $SUDO yum install -y -q wireguard-tools curl ca-certificates tar coreutils openssl || die 10 "yum install failed"
    ;;
esac
command -v wg >/dev/null 2>&1 || die 10 "wireguard-tools installation failed"
command -v wg-quick >/dev/null 2>&1 || die 10 "wg-quick installation failed"

if ! $SUDO modprobe wireguard 2>/dev/null; then
  [ -d /sys/module/wireguard ] || die 11 "kernel WireGuard support is unavailable"
fi

node_major() {
  "$1" --version 2>/dev/null | sed -n 's/^v\([0-9][0-9]*\).*/\1/p'
}

NODE_BIN=""
if command -v node >/dev/null 2>&1; then
  NODE_VERSION="$(node --version 2>/dev/null || printf '')"
  SYSTEM_NODE="$(command -v node)"
  SYSTEM_NODE_MAJOR="$(printf '%s' "${NODE_VERSION}" | sed -n 's/^v\([0-9][0-9]*\).*/\1/p')"
  if [ -n "${SYSTEM_NODE_MAJOR}" ] && [ "${SYSTEM_NODE_MAJOR}" -ge "${NODE_MIN_MAJOR}" ]; then
    NODE_BIN="${SYSTEM_NODE}"
  fi
fi
if [ -z "${NODE_BIN}" ] && [ -x "${NODE_RUNTIME_DIR}/bin/node" ]; then
  BUNDLED_NODE_MAJOR="$(node_major "${NODE_RUNTIME_DIR}/bin/node")"
  if [ -n "${BUNDLED_NODE_MAJOR}" ] && [ "${BUNDLED_NODE_MAJOR}" -ge "${NODE_MIN_MAJOR}" ]; then
    NODE_BIN="${NODE_RUNTIME_DIR}/bin/node"
  fi
fi

if [ -z "${NODE_BIN}" ]; then
  log "step: install-verified-node"
  case "$(uname -m)" in
    x86_64|amd64) NODE_ARCH="x64" ;;
    aarch64|arm64) NODE_ARCH="arm64" ;;
    *) die 10 "unsupported Node architecture" ;;
  esac
  NODE_ARCHIVE="node-${NODE_RELEASE}-linux-${NODE_ARCH}.tar.gz"
  NODE_URL="https://nodejs.org/dist/${NODE_RELEASE}"
  DOWNLOAD_DIR="$(mktemp -d)"
  curl -fsSLo "${DOWNLOAD_DIR}/${NODE_ARCHIVE}" "${NODE_URL}/${NODE_ARCHIVE}" || die 10 "Node download failed"
  curl -fsSLo "${DOWNLOAD_DIR}/SHASUMS256.txt" "${NODE_URL}/SHASUMS256.txt" || die 10 "Node checksum download failed"
  grep "  ${NODE_ARCHIVE}$" "${DOWNLOAD_DIR}/SHASUMS256.txt" > "${DOWNLOAD_DIR}/expected.sha256" || die 10 "Node checksum missing"
  (cd "${DOWNLOAD_DIR}" && sha256sum -c expected.sha256 >/dev/null) || die 10 "Node checksum verification failed"
  NODE_TMP="$($SUDO mktemp -d /opt/clawd-relay/.node.tmp.XXXXXX)"
  $SUDO tar -xzf "${DOWNLOAD_DIR}/${NODE_ARCHIVE}" -C "${NODE_TMP}" --strip-components=1
  CANDIDATE_NODE_MAJOR="$(node_major "${NODE_TMP}/bin/node")"
  [ -n "${CANDIDATE_NODE_MAJOR}" ] && [ "${CANDIDATE_NODE_MAJOR}" -ge "${NODE_MIN_MAJOR}" ] || die 10 "installed Node is too old"
  $SUDO rm -rf "${NODE_RUNTIME_DIR}"
  $SUDO mv "${NODE_TMP}" "${NODE_RUNTIME_DIR}"
  rm -rf "${DOWNLOAD_DIR}"
  NODE_BIN="${NODE_RUNTIME_DIR}/bin/node"
fi
[ "$(node_major "${NODE_BIN}")" -ge "${NODE_MIN_MAJOR}" ] || die 10 "Node >=18 is required"

log "step: install-relay-app"
[ -f "${SCRIPT_DIR}/app/relay-server.js" ] || die 16 "uploaded Relay app is incomplete"
[ -f "${SCRIPT_DIR}/app/pair-registry.js" ] || die 16 "uploaded Relay app is incomplete"
[ -f "${SCRIPT_DIR}/app/relay-token-store.js" ] || die 16 "uploaded Relay app is incomplete"
[ -f "${SCRIPT_DIR}/app/wg-management.js" ] || die 16 "uploaded Relay app is incomplete"
[ -f "${SCRIPT_DIR}/app/node_modules/ws/package.json" ] || die 16 "bundled node_modules/ws is missing"
APP_TMP="$($SUDO mktemp -d /opt/clawd-relay/.app.tmp.XXXXXX)"
$SUDO cp -a "${SCRIPT_DIR}/app/." "${APP_TMP}/"
$SUDO find "${APP_TMP}" -type d -exec chmod 755 {} +
$SUDO find "${APP_TMP}" -type f -exec chmod 644 {} +
"${NODE_BIN}" --check "${APP_TMP}/relay-server.js" >/dev/null
NODE_PATH="${APP_TMP}/node_modules" "${NODE_BIN}" -e 'require(process.argv[1]); require("ws")' "${APP_TMP}/relay-server.js" >/dev/null
$SUDO rm -rf "${APP_DIR}"
$SUDO mv "${APP_TMP}" "${APP_DIR}"

log "step: discover-endpoint"
ENDPOINT_HOST_VALUE="${ENDPOINT_HOST:-}"
if [ -z "${ENDPOINT_HOST_VALUE}" ]; then
  ENDPOINT_HOST_VALUE="$(curl -fsS --max-time 8 https://api.ipify.org 2>/dev/null || true)"
fi
if [ -z "${ENDPOINT_HOST_VALUE}" ]; then
  ENDPOINT_HOST_VALUE="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src"){print $(i+1); exit}}')"
fi
[ -n "${ENDPOINT_HOST_VALUE}" ] || die 17 "public endpoint discovery failed"
case "${ENDPOINT_HOST_VALUE}" in *[!A-Za-z0-9.:-]*) die 17 "public endpoint is invalid" ;; esac
ENDPOINT="${ENDPOINT_HOST_VALUE}:${WG_PORT}"

log "step: generate-wireguard-keys"
$SUDO mkdir -p "${WG_KEY_DIR}"
$SUDO chmod 700 "${WG_KEY_DIR}"

generate_key_pair() {
  local name="$1" force="$2"
  local private_path="${WG_KEY_DIR}/${name}.key"
  local public_path="${WG_KEY_DIR}/${name}.pub"
  if [ "${force}" != "1" ] && $SUDO test -s "${private_path}" && $SUDO test -s "${public_path}"; then
    return
  fi
  local private_tmp public_tmp
  private_tmp="$($SUDO mktemp "${WG_KEY_DIR}/.${name}.key.tmp.XXXXXX")"
  public_tmp="$($SUDO mktemp "${WG_KEY_DIR}/.${name}.pub.tmp.XXXXXX")"
  wg genkey | $SUDO tee "${private_tmp}" >/dev/null
  $SUDO sh -c "wg pubkey < '${private_tmp}' > '${public_tmp}'"
  $SUDO chmod 600 "${private_tmp}" "${public_tmp}"
  $SUDO mv "${private_tmp}" "${private_path}"
  $SUDO mv "${public_tmp}" "${public_path}"
}

generate_key_pair server 0
generate_key_pair pc 0
generate_key_pair phone "${FORCE_PHONE_KEY}"
$SUDO find "${WG_KEY_DIR}" -type f -exec chmod 600 {} +

SERVER_PRIV="$($SUDO cat "${WG_KEY_DIR}/server.key")"
SERVER_PUB="$($SUDO cat "${WG_KEY_DIR}/server.pub")"
PC_PRIV="$($SUDO cat "${WG_KEY_DIR}/pc.key")"
PC_PUB="$($SUDO cat "${WG_KEY_DIR}/pc.pub")"
PHONE_PRIV="$($SUDO cat "${WG_KEY_DIR}/phone.key")"
PHONE_PUB="$($SUDO cat "${WG_KEY_DIR}/phone.pub")"

log "step: write-wireguard-config"
WG_CONF_TMP="$($SUDO mktemp --suffix=.conf /etc/wireguard/.clawd.tmp.XXXXXX)"
printf '%s\n' "[Interface]
Address = ${SERVER_IP}/24
ListenPort = ${WG_PORT}
PrivateKey = ${SERVER_PRIV}

[Peer]
# pc
PublicKey = ${PC_PUB}
AllowedIPs = ${PC_IP}/32

[Peer]
# phone
PublicKey = ${PHONE_PUB}
AllowedIPs = ${PHONE_IP}/32" | $SUDO tee "${WG_CONF_TMP}" >/dev/null
$SUDO chmod 600 "${WG_CONF_TMP}"
$SUDO wg-quick strip "${WG_CONF_TMP}" >/dev/null || die 18 "WireGuard config validation failed"
$SUDO mv "${WG_CONF_TMP}" "${WG_CONF}"
$SUDO chmod 600 "${WG_CONF}"

if command -v ss >/dev/null 2>&1 && ss -lun 2>/dev/null | grep -q ":${WG_PORT} "; then
  $SUDO wg show "${IFACE}" >/dev/null 2>&1 || die 12 "WireGuard UDP port is already in use"
fi

read_env_value() {
  local key="$1"
  if $SUDO test -f "${RELAY_ENV}"; then
    $SUDO sed -n "s/^${key}=//p" "${RELAY_ENV}"
  fi
}

RELAY_TOKEN="$(read_env_value RELAY_TOKEN)"
MANAGEMENT_TOKEN="$(read_env_value MANAGEMENT_TOKEN)"
if ! [[ "${RELAY_TOKEN}" =~ ^[0-9a-fA-F]{64}$ ]]; then RELAY_TOKEN="$(openssl rand -hex 32)"; fi
if ! [[ "${MANAGEMENT_TOKEN}" =~ ^[0-9a-fA-F]{64}$ ]]; then MANAGEMENT_TOKEN="$(openssl rand -hex 32)"; fi
if [ "${RELAY_TOKEN,,}" = "${MANAGEMENT_TOKEN,,}" ]; then MANAGEMENT_TOKEN="$(openssl rand -hex 32)"; fi
[ "${RELAY_TOKEN,,}" != "${MANAGEMENT_TOKEN,,}" ] || die 19 "token generation failed"

log "step: write-relay-environment"
RELAY_ENV_TMP="$($SUDO mktemp /etc/clawd-relay/.relay.env.tmp.XXXXXX)"
printf '%s\n' "RELAY_TOKEN=${RELAY_TOKEN}
MANAGEMENT_TOKEN=${MANAGEMENT_TOKEN}
BIND_ADDR=${SERVER_IP}
PORT=${RELAY_PORT}
PC_IP=${PC_IP}
PHONE_IP=${PHONE_IP}
WG_SUBNET=${WG_SUBNET}
WG_ENDPOINT=${ENDPOINT}
WG_INTERFACE=${IFACE}
WG_CONFIG_PATH=${WG_CONF}
WG_KEY_DIR=${WG_KEY_DIR}
PHONE_PRIVATE_KEY_PATH=${WG_KEY_DIR}/phone.key
PHONE_PUBLIC_KEY_PATH=${WG_KEY_DIR}/phone.pub
SERVER_PUBLIC_KEY_PATH=${WG_KEY_DIR}/server.pub
RELAY_ENV_PATH=${RELAY_ENV}" | $SUDO tee "${RELAY_ENV_TMP}" >/dev/null
$SUDO chmod 600 "${RELAY_ENV_TMP}"
$SUDO mv "${RELAY_ENV_TMP}" "${RELAY_ENV}"
$SUDO chmod 600 "${RELAY_ENV}"

log "step: write-systemd-unit"
UNIT_TMP="$($SUDO mktemp /etc/systemd/system/.clawd-relay.service.tmp.XXXXXX)"
printf '%s\n' "[Unit]
Description=Clawd Relay
Requires=wg-quick@${IFACE}.service
After=network-online.target wg-quick@${IFACE}.service

[Service]
Type=simple
EnvironmentFile=/etc/clawd-relay/relay.env
ExecStart=${NODE_BIN} ${APP_DIR}/relay-server.js
Restart=always
RestartSec=3
UMask=0077

[Install]
WantedBy=multi-user.target" | $SUDO tee "${UNIT_TMP}" >/dev/null
$SUDO chmod 644 "${UNIT_TMP}"
$SUDO mv "${UNIT_TMP}" "${UNIT}"

log "step: firewall"
if command -v ufw >/dev/null 2>&1 && $SUDO ufw status >/dev/null 2>&1; then
  $SUDO ufw allow "${WG_PORT}/udp" >/dev/null || die 14 "ufw update failed"
elif command -v firewall-cmd >/dev/null 2>&1 && $SUDO firewall-cmd --state >/dev/null 2>&1; then
  $SUDO firewall-cmd --permanent --add-port="${WG_PORT}/udp" >/dev/null || die 14 "firewalld update failed"
  $SUDO firewall-cmd --reload >/dev/null || die 14 "firewalld reload failed"
elif command -v iptables >/dev/null 2>&1; then
  if ! $SUDO iptables -C INPUT -p udp --dport "${WG_PORT}" -j ACCEPT 2>/dev/null; then
    $SUDO iptables -A INPUT -p udp --dport "${WG_PORT}" -j ACCEPT || die 14 "iptables update failed"
  fi
fi

log "step: enable-and-verify-services"
$SUDO systemctl daemon-reload || die 20 "systemd reload failed"
$SUDO systemctl enable "wg-quick@${IFACE}" >/dev/null || die 20 "WireGuard enable failed"
$SUDO systemctl restart "wg-quick@${IFACE}" || die 20 "WireGuard start failed"
$SUDO systemctl is-enabled --quiet "wg-quick@${IFACE}" || die 20 "WireGuard is not enabled"
$SUDO systemctl is-active --quiet "wg-quick@${IFACE}" || die 20 "WireGuard is not active"
$SUDO systemctl enable clawd-relay.service >/dev/null || die 20 "Relay enable failed"
$SUDO systemctl restart clawd-relay.service || die 20 "Relay start failed"
$SUDO systemctl is-enabled --quiet clawd-relay.service || die 20 "Relay is not enabled"
$SUDO systemctl is-active --quiet clawd-relay.service || die 20 "Relay is not active"

PC_CONF="[Interface]
PrivateKey = ${PC_PRIV}
Address = ${PC_IP}/32

[Peer]
PublicKey = ${SERVER_PUB}
Endpoint = ${ENDPOINT}
AllowedIPs = ${WG_SUBNET}
PersistentKeepalive = 25"
PHONE_CONF="[Interface]
PrivateKey = ${PHONE_PRIV}
Address = ${PHONE_IP}/32

[Peer]
PublicKey = ${SERVER_PUB}
Endpoint = ${ENDPOINT}
AllowedIPs = ${WG_SUBNET}
PersistentKeepalive = 25"

json_string() {
  "${NODE_BIN}" -e 'let value="";process.stdin.setEncoding("utf8");process.stdin.on("data",c=>value+=c);process.stdin.on("end",()=>process.stdout.write(JSON.stringify(value)));'
}

ENDPOINT_JSON="$(printf '%s' "${ENDPOINT}" | json_string)"
SUBNET_JSON="$(printf '%s' "${WG_SUBNET}" | json_string)"
RELAY_URL_JSON="$(printf 'ws://%s:%s' "${SERVER_IP}" "${RELAY_PORT}" | json_string)"
PC_CONFIG_JSON="$(printf '%s' "${PC_CONF}" | json_string)"
PHONE_CONFIG_JSON="$(printf '%s' "${PHONE_CONF}" | json_string)"
RELAY_TOKEN_JSON="$(printf '%s' "${RELAY_TOKEN}" | json_string)"
MANAGEMENT_TOKEN_JSON="$(printf '%s' "${MANAGEMENT_TOKEN}" | json_string)"
READBACK_JSON="$(printf '{"schemaVersion":1,"endpoint":%s,"subnet":%s,"relayUrl":%s,"pcConfig":%s,"phoneConfig":%s,"relayToken":%s,"managementToken":%s}' \
  "${ENDPOINT_JSON}" "${SUBNET_JSON}" "${RELAY_URL_JSON}" "${PC_CONFIG_JSON}" \
  "${PHONE_CONFIG_JSON}" "${RELAY_TOKEN_JSON}" "${MANAGEMENT_TOKEN_JSON}")"
COMMITTED=1
printf '<<<CLAWD_JSON>>>'
printf '%s' "${READBACK_JSON}"
printf '<<<END_CLAWD_JSON>>>\n'
log "done"
