#!/usr/bin/env bash
# Persistent, idempotent WireGuard + Clawd Relay installer.

set -euo pipefail
export LANG=C LC_ALL=C
umask 077

WG_PORT="${WG_PORT:-51820}"
WG_SUBNET="${WG_SUBNET:-10.8.0.0/24}"
RELAY_PORT="${RELAY_PORT:-7891}"
FORCE_RESET_ALL="${FORCE_RESET_ALL:-0}"
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
CURRENT="/opt/clawd-relay/current"
RELAY_ETC="/etc/clawd-relay"
RELAY_ENV="/etc/clawd-relay/relay.env"
UNIT="/etc/systemd/system/clawd-relay.service"
FIREWALL_UNIT="/etc/systemd/system/clawd-relay-firewall.service"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"

log() { printf '[wg-relay] %s\n' "$*" >&2; }
die() { log "ERROR: $2"; exit "$1"; }

validate_inputs() {
  local name value
  for name in WG_PORT RELAY_PORT WG_SUBNET FORCE_RESET_ALL FORCE_PHONE_KEY ENDPOINT_HOST; do
    value="${!name:-}"
    [[ "${value}" != *[[:cntrl:]]* ]] || die 64 "${name} contains control characters"
  done
  for name in WG_PORT RELAY_PORT; do
    value="${!name}"
    [[ "${value}" =~ ^[0-9]+$ ]] || die 64 "${name} must be an integer"
    [ "$((10#${value}))" -ge 1 ] && [ "$((10#${value}))" -le 65535 ] ||
      die 64 "${name} must be between 1 and 65535"
  done
  [[ "${FORCE_RESET_ALL}" = 0 || "${FORCE_RESET_ALL}" = 1 ]] ||
    die 64 "FORCE_RESET_ALL must be 0 or 1"
  [[ "${FORCE_PHONE_KEY}" = 0 || "${FORCE_PHONE_KEY}" = 1 ]] ||
    die 64 "FORCE_PHONE_KEY must be 0 or 1"
  local octet='(0|[1-9][0-9]?|1[0-9]{2}|2[0-4][0-9]|25[0-5])'
  [[ "${WG_SUBNET}" =~ ^${octet}\.${octet}\.${octet}\.0/24$ ]] ||
    die 64 "WG_SUBNET must be a canonical /24 network"
  local a="${BASH_REMATCH[1]}" b="${BASH_REMATCH[2]}"
  if ! { [ "${a}" -eq 10 ] ||
    { [ "${a}" -eq 172 ] && [ "${b}" -ge 16 ] && [ "${b}" -le 31 ]; } ||
    { [ "${a}" -eq 192 ] && [ "${b}" -eq 168 ]; }; }; then
    die 64 "WG_SUBNET must be private"
  fi
}

validate_inputs

# FORCE_PHONE_KEY was the deployer's old reinstall flag. Phone-only replacement is
# now the management API, so retaining this flag as a full-reset alias is safest.
if [ "${FORCE_PHONE_KEY}" = "1" ]; then FORCE_RESET_ALL=1; fi

TEST_MODE="${CLAWD_INSTALL_TEST_MODE:-0}"
INSTALL_ROOT=""
if [ "${TEST_MODE}" = "1" ]; then
  INSTALL_ROOT="${CLAWD_INSTALL_ROOT:?CLAWD_INSTALL_ROOT is required in test mode}"
  case "${INSTALL_ROOT}" in /*) ;; *) printf 'invalid test root\n' >&2; exit 64 ;; esac
  [ "${INSTALL_ROOT}" != "/" ] || { printf 'invalid test root\n' >&2; exit 64; }
fi

install_path() { printf '%s%s' "${INSTALL_ROOT}" "$1"; }
WG_DIR_FS="$(install_path "${WG_DIR}")"
WG_KEY_DIR_FS="$(install_path "${WG_KEY_DIR}")"
WG_CONF_FS="$(install_path "${WG_CONF}")"
RELAY_ROOT_FS="$(install_path "${RELAY_ROOT}")"
APP_DIR_FS="$(install_path "${APP_DIR}")"
NODE_RUNTIME_DIR_FS="$(install_path "${NODE_RUNTIME_DIR}")"
CURRENT_FS="$(install_path "${CURRENT}")"
RELAY_ETC_FS="$(install_path "${RELAY_ETC}")"
RELAY_ENV_FS="$(install_path "${RELAY_ENV}")"
UNIT_FS="$(install_path "${UNIT}")"
FIREWALL_UNIT_FS="$(install_path "${FIREWALL_UNIT}")"
SYSTEMD_RUN_FS="$(install_path "/run/systemd/system")"
VAR_TMP_FS="$(install_path "/var/tmp")"
RELEASES_FS="${RELAY_ROOT_FS}/releases"
NODE_CACHE_DIR_FS="${RELAY_ROOT_FS}/runtime-cache"
LOCK_FILE_FS="$(install_path "/run/lock/clawd-relay.lock")"

SUBNET_BASE="${WG_SUBNET%.*/*}"
SERVER_IP="${SUBNET_BASE}.1"
PC_IP="${SUBNET_BASE}.2"
PHONE_IP="${SUBNET_BASE}.3"

checkpoint() {
  if [ "${TEST_MODE}" = "1" ] && [ "${CLAWD_INSTALL_FAIL_STAGE:-}" = "$1" ]; then
    die 97 "injected failure at $1"
  fi
  if [ "${TEST_MODE}" = "1" ] && [ "${CLAWD_INSTALL_PAUSE_STAGE:-}" = "$1" ]; then
    : > "${CLAWD_INSTALL_TEST_STATE:?}/pause-$1"
    while :; do sleep 0.05; done
  fi
}

SUDO=""
if [ "${TEST_MODE}" != "1" ] && [ "$(id -u)" -ne 0 ]; then
  if command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then
    SUDO="sudo"
  else
    die 13 "need root or passwordless sudo"
  fi
fi

LOCK_HELD=0
BACKUP_DIR=""
COMMITTED=0
ROLLING_BACK=0
FULL_ROLLBACK_READY=0
TEMP_ITEMS=()
NEW_RELEASES=()
OLD_RELEASES=()
EARLY_CREATED_DIRS=()
NODE_CACHE_ARCHIVE_CREATED=0

cleanup_created_directories() {
  local index
  for ((index=${#EARLY_CREATED_DIRS[@]}-1; index>=0; index--)); do
    $SUDO rmdir "${EARLY_CREATED_DIRS[index]}" 2>/dev/null || true
  done
}

release_lock() {
  [ "${LOCK_HELD}" = 1 ] || return
  exec 9>&-
  LOCK_HELD=0
}

early_exit() {
  local status=$?
  trap - EXIT HUP INT TERM
  [ -z "${BACKUP_DIR}" ] || $SUDO rm -rf "${BACKUP_DIR}"
  cleanup_created_directories
  release_lock
  exit "${status}"
}
on_signal() { exit "$1"; }
trap early_exit EXIT
trap 'on_signal 129' HUP
trap 'on_signal 130' INT
trap 'on_signal 143' TERM

acquire_lock() {
  command -v flock >/dev/null 2>&1 || die 15 "util-linux flock is required"
  local timeout_ms=5000
  if [ "${TEST_MODE}" = 1 ] && [[ "${CLAWD_INSTALL_LOCK_TIMEOUT_MS:-}" =~ ^[0-9]+$ ]]; then
    timeout_ms="${CLAWD_INSTALL_LOCK_TIMEOUT_MS}"
  fi
  $SUDO test ! -d "${LOCK_FILE_FS}" || die 21 "installer lock path must be a file"
  : >> "${LOCK_FILE_FS}"
  chmod 600 "${LOCK_FILE_FS}"
  exec 9>>"${LOCK_FILE_FS}"
  local timeout_seconds
  timeout_seconds="$(printf '%d.%03d' "$((timeout_ms / 1000))" "$((timeout_ms % 1000))")"
  flock -x -w "${timeout_seconds}" 9 || die 21 "installer lock timeout"
  LOCK_HELD=1
}

acquire_lock
checkpoint lock-acquired

command -v systemctl >/dev/null 2>&1 || die 15 "systemd is required"
[ -d "${SYSTEMD_RUN_FS}" ] || die 15 "systemd is not running (/run/systemd/system)"

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

ensure_directory() {
  local directory="$1" mode="$2"
  if ! $SUDO test -d "${directory}"; then
    local parent
    parent="$(dirname "${directory}")"
    if ! $SUDO test -d "${parent}"; then ensure_directory "${parent}" 755; fi
    $SUDO mkdir "${directory}"
    $SUDO chmod "${mode}" "${directory}"
    EARLY_CREATED_DIRS+=("${directory}")
  fi
}
ensure_directory "${RELAY_ROOT_FS}" 755
ensure_directory "${RELAY_ETC_FS}" 700
ensure_directory "${WG_DIR_FS}" 700
ensure_directory "${RELEASES_FS}" 755
ensure_directory "${VAR_TMP_FS}" 700
ensure_directory "$(dirname "${UNIT_FS}")" 755
if $SUDO test -e "${CURRENT_FS}" || $SUDO test -L "${CURRENT_FS}"; then
  $SUDO test -L "${CURRENT_FS}" || die 16 "${CURRENT} must be a symlink"
  CURRENT_WAS_PRESENT=1
  CURRENT_OLD_TARGET="$($SUDO readlink "${CURRENT_FS}")"
else
  CURRENT_WAS_PRESENT=0
  CURRENT_OLD_TARGET=""
fi
BACKUP_DIR="$($SUDO mktemp -d "${VAR_TMP_FS}/clawd-relay-backup.XXXXXX")"
$SUDO chmod 700 "${BACKUP_DIR}"
SERVICE_SNAPSHOT_DONE=0
FIREWALL_ADDED=""
IPTABLES4_ADDED=0
IPTABLES6_ADDED=0
CURRENT_SWITCHED=0
APP_LINK_CREATED=0
NODE_LINK_CREATED=0
FULL_ROLLBACK_READY=1

remember_temp() { TEMP_ITEMS+=("$1"); }
remember_release() { NEW_RELEASES+=("$1"); }

item_exists() { $SUDO test -e "$1" || $SUDO test -L "$1"; }
backup_item() {
  local source="$1" name="$2"
  if item_exists "${source}"; then
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

backup_item "${WG_KEY_DIR_FS}" keys
backup_item "${WG_CONF_FS}" wg-conf
backup_item "${RELAY_ENV_FS}" relay-env
backup_item "${UNIT_FS}" relay-unit
backup_item "${FIREWALL_UNIT_FS}" firewall-unit

service_enabled() { $SUDO systemctl is-enabled --quiet "$1" >/dev/null 2>&1 && printf 1 || printf 0; }
service_active() { $SUDO systemctl is-active --quiet "$1" >/dev/null 2>&1 && printf 1 || printf 0; }
WG_WAS_ENABLED="$(service_enabled "wg-quick@${IFACE}")"
WG_WAS_ACTIVE="$(service_active "wg-quick@${IFACE}")"
RELAY_WAS_ENABLED="$(service_enabled clawd-relay.service)"
RELAY_WAS_ACTIVE="$(service_active clawd-relay.service)"
FIREWALL_WAS_ENABLED="$(service_enabled clawd-relay-firewall.service)"
FIREWALL_WAS_ACTIVE="$(service_active clawd-relay-firewall.service)"
SERVICE_SNAPSHOT_DONE=1

restore_service() {
  local service="$1" was_enabled="$2" was_active="$3"
  if [ "${was_enabled}" = 1 ]; then
    $SUDO systemctl enable "${service}" >/dev/null 2>&1
  else
    $SUDO systemctl disable "${service}" >/dev/null 2>&1
  fi
  if [ "${was_active}" = 1 ]; then
    $SUDO systemctl restart "${service}" >/dev/null 2>&1
  else
    $SUDO systemctl stop "${service}" >/dev/null 2>&1
  fi
}

undo_firewall() {
  case "${FIREWALL_ADDED}" in
    ufw) $SUDO ufw --force delete allow "${WG_PORT}/udp" >/dev/null 2>&1 ;;
    firewalld)
      $SUDO firewall-cmd --permanent --remove-port="${WG_PORT}/udp" >/dev/null 2>&1
      $SUDO firewall-cmd --reload >/dev/null 2>&1
      ;;
    iptables)
      [ "${IPTABLES4_ADDED}" = 0 ] || $SUDO iptables -D INPUT -p udp --dport "${WG_PORT}" -j ACCEPT >/dev/null 2>&1
      [ "${IPTABLES6_ADDED}" = 0 ] || $SUDO ip6tables -D INPUT -p udp --dport "${WG_PORT}" -j ACCEPT >/dev/null 2>&1
      ;;
  esac
}

cleanup_temporaries() {
  local item
  for item in "${TEMP_ITEMS[@]:-}"; do [ -z "${item}" ] || $SUDO rm -rf "${item}"; done
}

rollback() {
  [ "${ROLLING_BACK}" = 0 ] || return
  ROLLING_BACK=1
  set +e
  log "restoring previous Relay installation"
  undo_firewall
  if [ "${CURRENT_SWITCHED}" = 1 ]; then
    if [ "${CURRENT_WAS_PRESENT}" = 1 ]; then
      atomic_link "${CURRENT_OLD_TARGET}" "${CURRENT_FS}"
    else
      $SUDO rm -f "${CURRENT_FS}"
    fi
  fi
  if [ "${APP_LINK_CREATED}" = 1 ]; then $SUDO rm -f "${APP_DIR_FS}"; fi
  if [ "${NODE_LINK_CREATED}" = 1 ]; then $SUDO rm -f "${NODE_RUNTIME_DIR_FS}"; fi
  restore_item "${WG_KEY_DIR_FS}" keys
  restore_item "${WG_CONF_FS}" wg-conf
  restore_item "${RELAY_ENV_FS}" relay-env
  restore_item "${UNIT_FS}" relay-unit
  restore_item "${FIREWALL_UNIT_FS}" firewall-unit
  if [ "${NODE_CACHE_ARCHIVE_CREATED}" = 1 ]; then $SUDO rm -f "${NODE_CACHE_ARCHIVE}"; fi
  local release
  for release in "${NEW_RELEASES[@]:-}"; do [ -z "${release}" ] || $SUDO rm -rf "${release}"; done
  if [ "${SERVICE_SNAPSHOT_DONE}" = 1 ]; then
    $SUDO systemctl daemon-reload >/dev/null 2>&1
    restore_service "wg-quick@${IFACE}" "${WG_WAS_ENABLED}" "${WG_WAS_ACTIVE}"
    restore_service clawd-relay.service "${RELAY_WAS_ENABLED}" "${RELAY_WAS_ACTIVE}"
    restore_service clawd-relay-firewall.service "${FIREWALL_WAS_ENABLED}" "${FIREWALL_WAS_ACTIVE}"
  fi
}

on_exit() {
  local status=$?
  trap - EXIT HUP INT TERM
  if [ "${status}" -ne 0 ] && [ "${COMMITTED}" -ne 1 ] && [ "${FULL_ROLLBACK_READY}" = 1 ]; then rollback; fi
  cleanup_temporaries
  [ -z "${BACKUP_DIR}" ] || $SUDO rm -rf "${BACKUP_DIR}"
  if [ "${status}" -ne 0 ]; then cleanup_created_directories; fi
  release_lock
  exit "${status}"
}
on_signal() { exit "$1"; }
trap on_exit EXIT
trap 'on_signal 129' HUP
trap 'on_signal 130' INT
trap 'on_signal 143' TERM

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
  [ -d "$(install_path "/sys/module/wireguard")" ] || die 11 "kernel WireGuard support is unavailable"
fi

node_major() { "$1" --version 2>/dev/null | sed -n 's/^v\([0-9][0-9]*\).*/\1/p'; }
atomic_link() {
  local target="$1" canonical="$2" temporary="${2}.new"
  if item_exists "${canonical}" && ! $SUDO test -L "${canonical}"; then
    die 16 "${canonical} must be a symlink"
  fi
  $SUDO rm -f "${temporary}"
  $SUDO ln -s "${target}" "${temporary}"
  remember_temp "${temporary}"
  if [ "${TEST_MODE}" = 1 ]; then
    "${CLAWD_INSTALL_TEST_NODE_SOURCE:?}" -e 'require("fs").renameSync(process.argv[1], process.argv[2])' "${temporary}" "${canonical}"
  else
    $SUDO mv -Tf "${temporary}" "${canonical}"
  fi
}

log "step: install-relay-app"
APP_SOURCE="${SCRIPT_DIR}/app"
if [ "${TEST_MODE}" = 1 ] && [ -n "${CLAWD_INSTALL_APP_SOURCE:-}" ]; then APP_SOURCE="${CLAWD_INSTALL_APP_SOURCE}"; fi
[ -f "${APP_SOURCE}/relay-server.js" ] || die 16 "uploaded Relay app is incomplete"
[ -f "${APP_SOURCE}/pair-registry.js" ] || die 16 "uploaded Relay app is incomplete"
[ -f "${APP_SOURCE}/relay-token-store.js" ] || die 16 "uploaded Relay app is incomplete"
[ -f "${APP_SOURCE}/wg-management.js" ] || die 16 "uploaded Relay app is incomplete"
[ -f "${APP_SOURCE}/node_modules/ws/package.json" ] || die 16 "bundled node_modules/ws is missing"
RELEASE_ID="$(date +%s).$$.$RANDOM"
RELEASE_FS="${RELEASES_FS}/release-${RELEASE_ID}"
RELEASE_APP_FS="${RELEASE_FS}/app"
RELEASE_NODE_FS="${RELEASE_FS}/node"
remember_release "${RELEASE_FS}"
$SUDO mkdir -p "${RELEASE_APP_FS}" "${RELEASE_NODE_FS}"
$SUDO cp -a "${APP_SOURCE}/." "${RELEASE_APP_FS}/"

log "step: install-verified-node"
case "$(uname -m)" in
  x86_64|amd64) NODE_ARCH="x64" ;;
  aarch64|arm64) NODE_ARCH="arm64" ;;
  *) die 10 "unsupported Node architecture" ;;
esac
NODE_ARCHIVE="node-${NODE_RELEASE}-linux-${NODE_ARCH}.tar.gz"
NODE_URL="https://nodejs.org/dist/${NODE_RELEASE}"
$SUDO test ! -L "${NODE_CACHE_DIR_FS}" || die 10 "Node cache directory is unsafe"
ensure_directory "${NODE_CACHE_DIR_FS}" 755
CACHE_EXPECTED_UID=0
if [ "${TEST_MODE}" = 1 ]; then CACHE_EXPECTED_UID="$(id -u)"; fi
NODE_CACHE_DIR_META="$($SUDO stat -c '%u:%a' "${NODE_CACHE_DIR_FS}")"
case "${NODE_CACHE_DIR_META}" in
  "${CACHE_EXPECTED_UID}:700"|"${CACHE_EXPECTED_UID}:755") ;;
  *) die 10 "Node cache directory ownership or mode is unsafe" ;;
esac
NODE_DOWNLOAD_DIR="$(mktemp -d)"
remember_temp "${NODE_DOWNLOAD_DIR}"
NODE_MANIFEST_TMP="${NODE_DOWNLOAD_DIR}/SHASUMS256.txt"
curl -fsSLo "${NODE_MANIFEST_TMP}" "${NODE_URL}/SHASUMS256.txt" || die 10 "Node checksum download failed"
NODE_EXPECTED_SHA="$(sed -n "s/^\([0-9a-fA-F]\{64\}\)  ${NODE_ARCHIVE}$/\1/p" "${NODE_MANIFEST_TMP}")"
[ "${#NODE_EXPECTED_SHA}" -eq 64 ] || die 10 "Node checksum missing"
NODE_CACHE_ARCHIVE="${NODE_CACHE_DIR_FS}/${NODE_ARCHIVE}"
if $SUDO test -e "${NODE_CACHE_ARCHIVE}" || $SUDO test -L "${NODE_CACHE_ARCHIVE}"; then
  $SUDO test -f "${NODE_CACHE_ARCHIVE}" && $SUDO test ! -L "${NODE_CACHE_ARCHIVE}" ||
    die 10 "Node cache archive is unsafe"
  [ "$($SUDO stat -c '%u:%a' "${NODE_CACHE_ARCHIVE}")" = "${CACHE_EXPECTED_UID}:444" ] ||
    die 10 "Node cache archive ownership or mode is unsafe"
fi
verify_node_archive() {
  local archive="$1"
  printf '%s  %s\n' "${NODE_EXPECTED_SHA}" "${archive}" | $SUDO sha256sum -c - >/dev/null 2>&1 ||
    die 10 "Node checksum verification failed"
}
if $SUDO test -f "${NODE_CACHE_ARCHIVE}"; then
  verify_node_archive "${NODE_CACHE_ARCHIVE}"
else
  NODE_DOWNLOADED_ARCHIVE="${NODE_DOWNLOAD_DIR}/${NODE_ARCHIVE}"
  curl -fsSLo "${NODE_DOWNLOADED_ARCHIVE}" "${NODE_URL}/${NODE_ARCHIVE}" || die 10 "Node download failed"
  verify_node_archive "${NODE_DOWNLOADED_ARCHIVE}"
  NODE_CACHE_TMP="$($SUDO mktemp "${NODE_CACHE_DIR_FS}/.${NODE_ARCHIVE}.tmp.XXXXXX")"
  remember_temp "${NODE_CACHE_TMP}"
  $SUDO cp "${NODE_DOWNLOADED_ARCHIVE}" "${NODE_CACHE_TMP}"
  $SUDO chmod 444 "${NODE_CACHE_TMP}"
  $SUDO mv "${NODE_CACHE_TMP}" "${NODE_CACHE_ARCHIVE}"
  NODE_CACHE_ARCHIVE_CREATED=1
fi
[ "$($SUDO stat -c '%u:%a' "${NODE_CACHE_ARCHIVE}")" = "${CACHE_EXPECTED_UID}:444" ] ||
  die 10 "Node cache archive ownership or mode is unsafe"
verify_node_archive "${NODE_CACHE_ARCHIVE}"
$SUDO tar -xzf "${NODE_CACHE_ARCHIVE}" -C "${RELEASE_NODE_FS}" --strip-components=1

$SUDO chmod 755 "${RELEASE_FS}" "${RELEASE_NODE_FS}"
$SUDO find "${RELEASE_NODE_FS}" -type d -exec chmod 755 {} +
$SUDO find "${RELEASE_APP_FS}" -type d -exec chmod 755 {} +
$SUDO find "${RELEASE_APP_FS}" -type f -exec chmod 644 {} +
NODE_BIN_FS="${RELEASE_NODE_FS}/bin/node"
[ "$(node_major "${NODE_BIN_FS}")" -ge "${NODE_MIN_MAJOR}" ] || die 10 "Node >=18 is required"
"${NODE_BIN_FS}" --check "${RELEASE_APP_FS}/relay-server.js" >/dev/null
NODE_PATH="${RELEASE_APP_FS}/node_modules" "${NODE_BIN_FS}" -e 'require(process.argv[1]); require("ws")' "${RELEASE_APP_FS}/relay-server.js" >/dev/null
checkpoint release-staged

case "${CURRENT_OLD_TARGET}" in "${RELEASES_FS}"/*) OLD_RELEASES+=("${CURRENT_OLD_TARGET}") ;; esac
CURRENT_SWITCHED=1
atomic_link "${RELEASE_FS}" "${CURRENT_FS}"
checkpoint current-switch

if ! item_exists "${APP_DIR_FS}"; then
  APP_LINK_CREATED=1
  $SUDO ln -s "${CURRENT_FS}/app" "${APP_DIR_FS}"
elif $SUDO test -d "${APP_DIR_FS}" && ! $SUDO test -L "${APP_DIR_FS}"; then
  log "legacy app directory preserved at ${APP_DIR}"
fi
if ! item_exists "${NODE_RUNTIME_DIR_FS}"; then
  NODE_LINK_CREATED=1
  $SUDO ln -s "${CURRENT_FS}/node" "${NODE_RUNTIME_DIR_FS}"
elif $SUDO test -d "${NODE_RUNTIME_DIR_FS}" && ! $SUDO test -L "${NODE_RUNTIME_DIR_FS}"; then
  log "legacy Node directory preserved at ${NODE_RUNTIME_DIR}"
fi
NODE_BIN_FS="${CURRENT_FS}/node/bin/node"

log "step: discover-endpoint"
ENDPOINT_HOST_VALUE="${ENDPOINT_HOST:-}"
if [ -z "${ENDPOINT_HOST_VALUE}" ]; then ENDPOINT_HOST_VALUE="$(curl -fsS --max-time 8 https://api.ipify.org 2>/dev/null || true)"; fi
if [ -z "${ENDPOINT_HOST_VALUE}" ]; then ENDPOINT_HOST_VALUE="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src"){print $(i+1); exit}}')"; fi
[ -n "${ENDPOINT_HOST_VALUE}" ] || die 17 "public endpoint discovery failed"
case "${ENDPOINT_HOST_VALUE}" in *[!A-Za-z0-9.:-]*) die 17 "public endpoint is invalid" ;; esac
case "${ENDPOINT_HOST_VALUE}" in
  *:*) ENDPOINT="[${ENDPOINT_HOST_VALUE}]:${WG_PORT}" ;;
  *) ENDPOINT="${ENDPOINT_HOST_VALUE}:${WG_PORT}" ;;
esac

log "step: generate-wireguard-keys"
$SUDO mkdir -p "${WG_KEY_DIR_FS}"
$SUDO chmod 700 "${WG_KEY_DIR_FS}"
generate_key_pair() {
  local name="$1" force="$2" private_path="${WG_KEY_DIR_FS}/$1.key" public_path="${WG_KEY_DIR_FS}/$1.pub"
  if [ "${force}" != 1 ] && $SUDO test -s "${private_path}" && $SUDO test -s "${public_path}"; then return; fi
  local private_tmp public_tmp
  private_tmp="$($SUDO mktemp "${WG_KEY_DIR_FS}/.${name}.key.tmp.XXXXXX")"; remember_temp "${private_tmp}"
  public_tmp="$($SUDO mktemp "${WG_KEY_DIR_FS}/.${name}.pub.tmp.XXXXXX")"; remember_temp "${public_tmp}"
  wg genkey | $SUDO tee "${private_tmp}" >/dev/null
  $SUDO sh -c "wg pubkey < '${private_tmp}' > '${public_tmp}'"
  $SUDO chmod 600 "${private_tmp}" "${public_tmp}"
  $SUDO mv "${private_tmp}" "${private_path}"
  $SUDO mv "${public_tmp}" "${public_path}"
}
generate_key_pair server "${FORCE_RESET_ALL}"
generate_key_pair pc "${FORCE_RESET_ALL}"
generate_key_pair phone "${FORCE_RESET_ALL}"
$SUDO find "${WG_KEY_DIR_FS}" -type f -exec chmod 600 {} +
checkpoint wireguard-keys

SERVER_PRIV="$($SUDO cat "${WG_KEY_DIR_FS}/server.key")"
SERVER_PUB="$($SUDO cat "${WG_KEY_DIR_FS}/server.pub")"
PC_PRIV="$($SUDO cat "${WG_KEY_DIR_FS}/pc.key")"
PC_PUB="$($SUDO cat "${WG_KEY_DIR_FS}/pc.pub")"
PHONE_PRIV="$($SUDO cat "${WG_KEY_DIR_FS}/phone.key")"
PHONE_PUB="$($SUDO cat "${WG_KEY_DIR_FS}/phone.pub")"

log "step: write-wireguard-config"
WG_CONF_TMP="$($SUDO mktemp "${WG_DIR_FS}/.clawd.tmp.XXXXXX.conf")"; remember_temp "${WG_CONF_TMP}"
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
$SUDO mv "${WG_CONF_TMP}" "${WG_CONF_FS}"
$SUDO chmod 600 "${WG_CONF_FS}"
checkpoint wireguard-config

read_env_value() {
  local key="$1"
  if $SUDO test -f "${RELAY_ENV_FS}"; then $SUDO sed -n "s/^${key}=//p" "${RELAY_ENV_FS}"; fi
}
RELAY_TOKEN="$(read_env_value RELAY_TOKEN)"
MANAGEMENT_TOKEN="$(read_env_value MANAGEMENT_TOKEN)"
if [ "${FORCE_RESET_ALL}" = 1 ] || ! [[ "${RELAY_TOKEN}" =~ ^[0-9a-fA-F]{64}$ ]]; then RELAY_TOKEN="$(openssl rand -hex 32)"; fi
if [ "${FORCE_RESET_ALL}" = 1 ] || ! [[ "${MANAGEMENT_TOKEN}" =~ ^[0-9a-fA-F]{64}$ ]]; then MANAGEMENT_TOKEN="$(openssl rand -hex 32)"; fi
RELAY_TOKEN_NORMALIZED="$(printf '%s' "${RELAY_TOKEN}" | tr '[:upper:]' '[:lower:]')"
MANAGEMENT_TOKEN_NORMALIZED="$(printf '%s' "${MANAGEMENT_TOKEN}" | tr '[:upper:]' '[:lower:]')"
if [ "${RELAY_TOKEN_NORMALIZED}" = "${MANAGEMENT_TOKEN_NORMALIZED}" ]; then
  MANAGEMENT_TOKEN="$(openssl rand -hex 32)"
  MANAGEMENT_TOKEN_NORMALIZED="$(printf '%s' "${MANAGEMENT_TOKEN}" | tr '[:upper:]' '[:lower:]')"
fi
[ "${RELAY_TOKEN_NORMALIZED}" != "${MANAGEMENT_TOKEN_NORMALIZED}" ] || die 19 "token generation failed"

log "step: write-relay-environment"
RELAY_ENV_TMP="$($SUDO mktemp "${RELAY_ETC_FS}/.relay.env.tmp.XXXXXX")"; remember_temp "${RELAY_ENV_TMP}"
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
$SUDO mv "${RELAY_ENV_TMP}" "${RELAY_ENV_FS}"
$SUDO chmod 600 "${RELAY_ENV_FS}"
checkpoint relay-environment

log "step: write-systemd-unit"
UNIT_TMP="$($SUDO mktemp "$(dirname "${UNIT_FS}")/.clawd-relay.service.tmp.XXXXXX")"; remember_temp "${UNIT_TMP}"
printf '%s\n' "[Unit]
Description=Clawd Relay
Requires=wg-quick@${IFACE}.service
After=network-online.target wg-quick@${IFACE}.service

[Service]
Type=simple
EnvironmentFile=/etc/clawd-relay/relay.env
ExecStart=/opt/clawd-relay/current/node/bin/node /opt/clawd-relay/current/app/relay-server.js
Restart=always
RestartSec=3
UMask=0077

[Install]
WantedBy=multi-user.target" | $SUDO tee "${UNIT_TMP}" >/dev/null
$SUDO chmod 644 "${UNIT_TMP}"
$SUDO mv "${UNIT_TMP}" "${UNIT_FS}"
checkpoint systemd-unit

log "step: firewall"
if command -v ufw >/dev/null 2>&1 && $SUDO ufw status >/dev/null 2>&1; then
  UFW_STATUS="$($SUDO ufw status)"
  UFW_V4=0
  UFW_V6=0
  printf '%s\n' "${UFW_STATUS}" | awk -v rule="${WG_PORT}/udp" '$1 == rule && $2 == "ALLOW" { found=1 } END { exit !found }' && UFW_V4=1
  printf '%s\n' "${UFW_STATUS}" | awk -v rule="${WG_PORT}/udp" '$1 == rule && $2 == "(v6)" && $3 == "ALLOW" { found=1 } END { exit !found }' && UFW_V6=1
  if [[ "${ENDPOINT_HOST_VALUE}" == *:* ]] && [ "${UFW_V4}" != "${UFW_V6}" ]; then
    die 14 "ufw lacks exact IPv6 rule coverage"
  fi
  if [ "${UFW_V4}" = 0 ]; then
    $SUDO ufw allow "${WG_PORT}/udp" >/dev/null || die 14 "ufw update failed"
    FIREWALL_ADDED=ufw
    UFW_STATUS="$($SUDO ufw status)"
    printf '%s\n' "${UFW_STATUS}" | awk -v rule="${WG_PORT}/udp" '$1 == rule && $2 == "ALLOW" { found=1 } END { exit !found }' ||
      die 14 "ufw IPv4 rule verification failed"
    if [[ "${ENDPOINT_HOST_VALUE}" == *:* ]]; then
      printf '%s\n' "${UFW_STATUS}" | awk -v rule="${WG_PORT}/udp" '$1 == rule && $2 == "(v6)" && $3 == "ALLOW" { found=1 } END { exit !found }' ||
        die 14 "ufw IPv6 rule verification failed"
    fi
  fi
elif command -v firewall-cmd >/dev/null 2>&1 && $SUDO firewall-cmd --state >/dev/null 2>&1; then
  if ! $SUDO firewall-cmd --permanent --query-port="${WG_PORT}/udp" >/dev/null 2>&1; then
    $SUDO firewall-cmd --permanent --add-port="${WG_PORT}/udp" >/dev/null || die 14 "firewalld update failed"
    FIREWALL_ADDED=firewalld
    $SUDO firewall-cmd --reload >/dev/null || die 14 "firewalld reload failed"
    $SUDO firewall-cmd --permanent --query-port="${WG_PORT}/udp" >/dev/null 2>&1 ||
      die 14 "firewalld rule verification failed"
  fi
elif command -v iptables >/dev/null 2>&1 && command -v ip6tables >/dev/null 2>&1; then
  IPTABLES_BIN="$(command -v iptables)"
  IP6TABLES_BIN="$(command -v ip6tables)"
  FIREWALL_ADDED=iptables
  if ! $SUDO iptables -C INPUT -p udp --dport "${WG_PORT}" -j ACCEPT 2>/dev/null; then
    $SUDO iptables -A INPUT -p udp --dport "${WG_PORT}" -j ACCEPT || die 14 "iptables update failed"
    IPTABLES4_ADDED=1
  fi
  if ! $SUDO ip6tables -C INPUT -p udp --dport "${WG_PORT}" -j ACCEPT 2>/dev/null; then
    $SUDO ip6tables -A INPUT -p udp --dport "${WG_PORT}" -j ACCEPT || die 14 "ip6tables update failed"
    IPTABLES6_ADDED=1
  fi
  $SUDO iptables -C INPUT -p udp --dport "${WG_PORT}" -j ACCEPT 2>/dev/null ||
    die 14 "iptables rule verification failed"
  $SUDO ip6tables -C INPUT -p udp --dport "${WG_PORT}" -j ACCEPT 2>/dev/null ||
    die 14 "ip6tables rule verification failed"
  FIREWALL_UNIT_TMP="$($SUDO mktemp "$(dirname "${FIREWALL_UNIT_FS}")/.clawd-relay-firewall.service.tmp.XXXXXX")"
  remember_temp "${FIREWALL_UNIT_TMP}"
  printf '%s\n' "[Unit]
Description=Persist Clawd WireGuard firewall rules
Before=wg-quick@${IFACE}.service

[Service]
Type=oneshot
ExecStart=/bin/sh -ec '${IPTABLES_BIN} -C INPUT -p udp --dport ${WG_PORT} -j ACCEPT || ${IPTABLES_BIN} -A INPUT -p udp --dport ${WG_PORT} -j ACCEPT; ${IP6TABLES_BIN} -C INPUT -p udp --dport ${WG_PORT} -j ACCEPT || ${IP6TABLES_BIN} -A INPUT -p udp --dport ${WG_PORT} -j ACCEPT'
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target" | $SUDO tee "${FIREWALL_UNIT_TMP}" >/dev/null
  $SUDO chmod 644 "${FIREWALL_UNIT_TMP}"
  $SUDO mv "${FIREWALL_UNIT_TMP}" "${FIREWALL_UNIT_FS}"
  $SUDO systemctl daemon-reload || die 14 "firewall service reload failed"
  $SUDO systemctl enable clawd-relay-firewall.service >/dev/null || die 14 "firewall service enable failed"
  $SUDO systemctl restart clawd-relay-firewall.service || die 14 "firewall service start failed"
  $SUDO systemctl is-enabled --quiet clawd-relay-firewall.service || die 14 "firewall service is not enabled"
  $SUDO systemctl is-active --quiet clawd-relay-firewall.service || die 14 "firewall service is not active"
else
  die 14 "no supported firewall backend"
fi
checkpoint firewall-rule

log "step: enable-and-verify-services"
$SUDO systemctl daemon-reload || die 20 "systemd reload failed"
$SUDO systemctl enable "wg-quick@${IFACE}" >/dev/null || die 20 "WireGuard enable failed"
$SUDO systemctl restart "wg-quick@${IFACE}" || die 20 "WireGuard start failed"
$SUDO systemctl is-enabled --quiet "wg-quick@${IFACE}" || die 20 "WireGuard is not enabled"
$SUDO systemctl is-active --quiet "wg-quick@${IFACE}" || die 20 "WireGuard is not active"
checkpoint wireguard-service
$SUDO systemctl enable clawd-relay.service >/dev/null || die 20 "Relay enable failed"
$SUDO systemctl restart clawd-relay.service || die 20 "Relay start failed"
$SUDO systemctl is-enabled --quiet clawd-relay.service || die 20 "Relay is not enabled"
$SUDO systemctl is-active --quiet clawd-relay.service || die 20 "Relay is not active"
checkpoint relay-service

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
json_string() { "${NODE_BIN_FS}" -e 'let value="";process.stdin.setEncoding("utf8");process.stdin.on("data",c=>value+=c);process.stdin.on("end",()=>process.stdout.write(JSON.stringify(value)));'; }
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
checkpoint readback
COMMITTED=1
printf '<<<CLAWD_JSON>>>'
printf '%s' "${READBACK_JSON}"
printf '<<<END_CLAWD_JSON>>>\n'

# Old successful releases are no longer needed after the readback transaction commits.
for old_release in "${OLD_RELEASES[@]:-}"; do
  [ -z "${old_release}" ] || [ "${old_release}" = "${RELEASE_FS}" ] || $SUDO rm -rf "${old_release}"
done
log "done"
