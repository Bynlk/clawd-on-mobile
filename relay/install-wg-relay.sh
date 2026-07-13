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
TEST_MODE="${CLAWD_INSTALL_TEST_MODE:-0}"
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
FIREWALL_METADATA="/etc/clawd-relay/firewall.env"
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

if [ "${TEST_MODE}" != "1" ] && [ "$(id -u)" -ne 0 ]; then
  die 13 "installer must run as root"
fi

# FORCE_PHONE_KEY was the deployer's old reinstall flag. Phone-only replacement is
# now the management API, so retaining this flag as a full-reset alias is safest.
if [ "${FORCE_PHONE_KEY}" = "1" ]; then FORCE_RESET_ALL=1; fi

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
FIREWALL_METADATA_FS="$(install_path "${FIREWALL_METADATA}")"
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
    rmdir "${EARLY_CREATED_DIRS[index]}" 2>/dev/null || true
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
  [ -z "${BACKUP_DIR}" ] || rm -rf "${BACKUP_DIR}"
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
  [ ! -L "${LOCK_FILE_FS}" ] || die 21 "installer lock path must not be a symlink"
  if [ -e "${LOCK_FILE_FS}" ]; then
    [ -f "${LOCK_FILE_FS}" ] || die 21 "installer lock path must be a regular file"
  fi
  exec 9>>"${LOCK_FILE_FS}"
  local fd_path="/proc/self/fd/9"
  [ -e "${fd_path}" ] || fd_path="/dev/fd/9"
  local path_stat fd_stat path_device path_inode path_uid path_mode path_type
  local fd_device fd_inode fd_uid fd_mode fd_type expected_uid
  path_stat="$(stat -Lc '%d:%i:%u:%a:%F' "${LOCK_FILE_FS}")" ||
    die 21 "installer lock path metadata is unavailable"
  fd_stat="$(stat -Lc '%d:%i:%u:%a:%F' "${fd_path}")" ||
    die 21 "installer lock descriptor metadata is unavailable"
  IFS=: read -r path_device path_inode path_uid path_mode path_type <<<"${path_stat}"
  IFS=: read -r fd_device fd_inode fd_uid fd_mode fd_type <<<"${fd_stat}"
  expected_uid=0
  if [ "${TEST_MODE}" = 1 ]; then expected_uid="$(id -u)"; fi
  [ ! -L "${LOCK_FILE_FS}" ] && [ "${path_type}" = "regular file" ] &&
    [ "${fd_type}" = "regular file" ] || die 21 "installer lock path must be a regular file"
  [ "${path_device}:${path_inode}" = "${fd_device}:${fd_inode}" ] ||
    die 21 "installer lock path changed while opening"
  [ "${path_uid}" = "${expected_uid}" ] && [ "${fd_uid}" = "${expected_uid}" ] ||
    die 21 "installer lock owner is invalid"
  [ "${path_mode}" = 600 ] && [ "${fd_mode}" = 600 ] ||
    die 21 "installer lock mode must be 0600"
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
  if ! test -d "${directory}"; then
    local parent
    parent="$(dirname "${directory}")"
    if ! test -d "${parent}"; then ensure_directory "${parent}" 755; fi
    mkdir "${directory}"
    chmod "${mode}" "${directory}"
    EARLY_CREATED_DIRS+=("${directory}")
  fi
}
ensure_directory "${RELAY_ROOT_FS}" 755
ensure_directory "${RELAY_ETC_FS}" 700
ensure_directory "${WG_DIR_FS}" 700
ensure_directory "${RELEASES_FS}" 755
ensure_directory "${VAR_TMP_FS}" 700
ensure_directory "$(dirname "${UNIT_FS}")" 755
if test -e "${CURRENT_FS}" || test -L "${CURRENT_FS}"; then
  test -L "${CURRENT_FS}" || die 16 "${CURRENT} must be a symlink"
  CURRENT_WAS_PRESENT=1
  CURRENT_OLD_TARGET="$(readlink "${CURRENT_FS}")"
else
  CURRENT_WAS_PRESENT=0
  CURRENT_OLD_TARGET=""
fi
BACKUP_DIR="$(mktemp -d "${VAR_TMP_FS}/clawd-relay-backup.XXXXXX")"
chmod 700 "${BACKUP_DIR}"
SERVICE_SNAPSHOT_DONE=0
FIREWALL_ADDED=""
IPTABLES4_ADDED=0
IPTABLES6_ADDED=0
OLD_FIREWALL_REMOVED_V4=0
OLD_FIREWALL_REMOVED_V6=0
OLD_FIREWALL_REMOVED_UNIT=0
CURRENT_SWITCHED=0
APP_LINK_CREATED=0
NODE_LINK_CREATED=0
FULL_ROLLBACK_READY=1

remember_temp() { TEMP_ITEMS+=("$1"); }
remember_release() { NEW_RELEASES+=("$1"); }

item_exists() { test -e "$1" || test -L "$1"; }
backup_item() {
  local source="$1" name="$2"
  if item_exists "${source}"; then
    cp -a "${source}" "${BACKUP_DIR}/${name}"
    touch "${BACKUP_DIR}/${name}.present"
  fi
}
restore_item() {
  local destination="$1" name="$2"
  rm -rf "${destination}"
  if test -e "${BACKUP_DIR}/${name}.present"; then
    cp -a "${BACKUP_DIR}/${name}" "${destination}"
  fi
}

backup_item "${WG_KEY_DIR_FS}" keys
backup_item "${WG_CONF_FS}" wg-conf
backup_item "${RELAY_ENV_FS}" relay-env
backup_item "${UNIT_FS}" relay-unit
backup_item "${FIREWALL_UNIT_FS}" firewall-unit
backup_item "${FIREWALL_METADATA_FS}" firewall-metadata

OLD_FIREWALL_BACKEND=""
OLD_FIREWALL_PORT=""
OLD_FIREWALL_IPV4=0
OLD_FIREWALL_IPV6=0
OLD_FIREWALL_UNIT=0
if item_exists "${FIREWALL_METADATA_FS}"; then
  EXPECTED_OWNER_UID=0
  if [ "${TEST_MODE}" = 1 ]; then EXPECTED_OWNER_UID="$(id -u)"; fi
  test -f "${FIREWALL_METADATA_FS}" && test ! -L "${FIREWALL_METADATA_FS}" ||
    die 14 "firewall metadata is unsafe"
  [ "$(stat -c '%u:%a' "${FIREWALL_METADATA_FS}")" = "${EXPECTED_OWNER_UID}:600" ] ||
    die 14 "firewall metadata ownership or mode is unsafe"
  [ "$(cat "${FIREWALL_METADATA_FS}" | wc -l | tr -d ' ')" -eq 5 ] ||
    die 14 "firewall metadata is invalid"
  for metadata_key in BACKEND PORT IPV4 IPV6 UNIT; do
    [ "$(sed -n "s/^${metadata_key}=//p" "${FIREWALL_METADATA_FS}" | wc -l | tr -d ' ')" -eq 1 ] ||
      die 14 "firewall metadata is invalid"
  done
  OLD_FIREWALL_BACKEND="$(sed -n 's/^BACKEND=//p' "${FIREWALL_METADATA_FS}")"
  OLD_FIREWALL_PORT="$(sed -n 's/^PORT=//p' "${FIREWALL_METADATA_FS}")"
  OLD_FIREWALL_IPV4="$(sed -n 's/^IPV4=//p' "${FIREWALL_METADATA_FS}")"
  OLD_FIREWALL_IPV6="$(sed -n 's/^IPV6=//p' "${FIREWALL_METADATA_FS}")"
  OLD_FIREWALL_UNIT="$(sed -n 's/^UNIT=//p' "${FIREWALL_METADATA_FS}")"
  case "${OLD_FIREWALL_BACKEND}" in ufw|firewalld|iptables) ;; *) die 14 "firewall metadata is invalid" ;; esac
  [[ "${OLD_FIREWALL_PORT}" =~ ^[0-9]+$ ]] && [ "${OLD_FIREWALL_PORT}" -ge 1 ] &&
    [ "${OLD_FIREWALL_PORT}" -le 65535 ] || die 14 "firewall metadata is invalid"
  for metadata_flag in "${OLD_FIREWALL_IPV4}" "${OLD_FIREWALL_IPV6}" "${OLD_FIREWALL_UNIT}"; do
    [ "${metadata_flag}" = 0 ] || [ "${metadata_flag}" = 1 ] || die 14 "firewall metadata is invalid"
  done
  if [ "${OLD_FIREWALL_BACKEND}" != iptables ] &&
    [ "${OLD_FIREWALL_IPV4}" != "${OLD_FIREWALL_IPV6}" ]; then
    die 14 "firewall metadata is invalid"
  fi
fi

service_enabled() { systemctl is-enabled --quiet "$1" >/dev/null 2>&1 && printf 1 || printf 0; }
service_active() { systemctl is-active --quiet "$1" >/dev/null 2>&1 && printf 1 || printf 0; }
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
    systemctl enable "${service}" >/dev/null 2>&1
  else
    systemctl disable "${service}" >/dev/null 2>&1
  fi
  if [ "${was_active}" = 1 ]; then
    systemctl restart "${service}" >/dev/null 2>&1
  else
    systemctl stop "${service}" >/dev/null 2>&1
  fi
}

undo_firewall() {
  case "${FIREWALL_ADDED}" in
    ufw) ufw --force delete allow "${WG_PORT}/udp" >/dev/null 2>&1 ;;
    firewalld)
      firewall-cmd --permanent --remove-port="${WG_PORT}/udp" >/dev/null 2>&1
      firewall-cmd --reload >/dev/null 2>&1
      ;;
    iptables)
      [ "${IPTABLES4_ADDED}" = 0 ] || iptables -D INPUT -p udp --dport "${WG_PORT}" -j ACCEPT >/dev/null 2>&1
      [ "${IPTABLES6_ADDED}" = 0 ] || ip6tables -D INPUT -p udp --dport "${WG_PORT}" -j ACCEPT >/dev/null 2>&1
      ;;
  esac
}

restore_obsolete_firewall() {
  [ -n "${OLD_FIREWALL_BACKEND}" ] || return 0
  case "${OLD_FIREWALL_BACKEND}" in
    ufw)
      if [ "${OLD_FIREWALL_REMOVED_V4}" = 1 ] || [ "${OLD_FIREWALL_REMOVED_V6}" = 1 ]; then
        ufw allow "${OLD_FIREWALL_PORT}/udp" >/dev/null 2>&1
      fi
      ;;
    firewalld)
      if [ "${OLD_FIREWALL_REMOVED_V4}" = 1 ] || [ "${OLD_FIREWALL_REMOVED_V6}" = 1 ]; then
        firewall-cmd --permanent --add-port="${OLD_FIREWALL_PORT}/udp" >/dev/null 2>&1
        firewall-cmd --reload >/dev/null 2>&1
      fi
      ;;
    iptables)
      if [ "${OLD_FIREWALL_REMOVED_V4}" = 1 ]; then
        iptables -C INPUT -p udp --dport "${OLD_FIREWALL_PORT}" -j ACCEPT >/dev/null 2>&1 ||
          iptables -A INPUT -p udp --dport "${OLD_FIREWALL_PORT}" -j ACCEPT >/dev/null 2>&1
      fi
      if [ "${OLD_FIREWALL_REMOVED_V6}" = 1 ]; then
        ip6tables -C INPUT -p udp --dport "${OLD_FIREWALL_PORT}" -j ACCEPT >/dev/null 2>&1 ||
          ip6tables -A INPUT -p udp --dport "${OLD_FIREWALL_PORT}" -j ACCEPT >/dev/null 2>&1
      fi
      ;;
  esac
}

remove_obsolete_firewall() {
  [ -n "${OLD_FIREWALL_BACKEND}" ] || return 0
  if [ "${OLD_FIREWALL_BACKEND}" = "${NEW_FIREWALL_BACKEND}" ] &&
    [ "${OLD_FIREWALL_PORT}" = "${WG_PORT}" ]; then
    return 0
  fi
  case "${OLD_FIREWALL_BACKEND}" in
    ufw)
      if [ "${OLD_FIREWALL_IPV4}" = 1 ] || [ "${OLD_FIREWALL_IPV6}" = 1 ]; then
        OLD_FIREWALL_REMOVED_V4="${OLD_FIREWALL_IPV4}"
        OLD_FIREWALL_REMOVED_V6="${OLD_FIREWALL_IPV6}"
        ufw --force delete allow "${OLD_FIREWALL_PORT}/udp" >/dev/null ||
          die 14 "obsolete ufw cleanup failed"
      fi
      ;;
    firewalld)
      if [ "${OLD_FIREWALL_IPV4}" = 1 ] || [ "${OLD_FIREWALL_IPV6}" = 1 ]; then
        OLD_FIREWALL_REMOVED_V4="${OLD_FIREWALL_IPV4}"
        OLD_FIREWALL_REMOVED_V6="${OLD_FIREWALL_IPV6}"
        firewall-cmd --permanent --remove-port="${OLD_FIREWALL_PORT}/udp" >/dev/null ||
          die 14 "obsolete firewalld cleanup failed"
        firewall-cmd --reload >/dev/null || die 14 "obsolete firewalld reload failed"
      fi
      ;;
    iptables)
      if [ "${OLD_FIREWALL_IPV4}" = 1 ]; then
        OLD_FIREWALL_REMOVED_V4=1
        iptables -D INPUT -p udp --dport "${OLD_FIREWALL_PORT}" -j ACCEPT >/dev/null ||
          die 14 "obsolete iptables cleanup failed"
      fi
      if [ "${OLD_FIREWALL_IPV6}" = 1 ]; then
        OLD_FIREWALL_REMOVED_V6=1
        ip6tables -D INPUT -p udp --dport "${OLD_FIREWALL_PORT}" -j ACCEPT >/dev/null ||
          die 14 "obsolete ip6tables cleanup failed"
      fi
      ;;
  esac
  if [ "${OLD_FIREWALL_UNIT}" = 1 ] && [ "${NEW_FIREWALL_BACKEND}" != iptables ]; then
    OLD_FIREWALL_REMOVED_UNIT=1
    systemctl stop clawd-relay-firewall.service >/dev/null || die 14 "obsolete firewall service stop failed"
    systemctl disable clawd-relay-firewall.service >/dev/null || die 14 "obsolete firewall service disable failed"
    rm -f "${FIREWALL_UNIT_FS}"
    systemctl daemon-reload || die 14 "obsolete firewall unit reload failed"
  fi
}

cleanup_temporaries() {
  local item
  for item in "${TEMP_ITEMS[@]:-}"; do [ -z "${item}" ] || rm -rf "${item}"; done
}

rollback() {
  [ "${ROLLING_BACK}" = 0 ] || return
  ROLLING_BACK=1
  set +e
  log "restoring previous Relay installation"
  undo_firewall
  restore_obsolete_firewall
  if [ "${CURRENT_SWITCHED}" = 1 ]; then
    if [ "${CURRENT_WAS_PRESENT}" = 1 ]; then
      atomic_link "${CURRENT_OLD_TARGET}" "${CURRENT_FS}"
    else
      rm -f "${CURRENT_FS}"
    fi
  fi
  if [ "${APP_LINK_CREATED}" = 1 ]; then rm -f "${APP_DIR_FS}"; fi
  if [ "${NODE_LINK_CREATED}" = 1 ]; then rm -f "${NODE_RUNTIME_DIR_FS}"; fi
  restore_item "${WG_KEY_DIR_FS}" keys
  restore_item "${WG_CONF_FS}" wg-conf
  restore_item "${RELAY_ENV_FS}" relay-env
  restore_item "${UNIT_FS}" relay-unit
  restore_item "${FIREWALL_UNIT_FS}" firewall-unit
  restore_item "${FIREWALL_METADATA_FS}" firewall-metadata
  if [ "${NODE_CACHE_ARCHIVE_CREATED}" = 1 ]; then rm -f "${NODE_CACHE_ARCHIVE}"; fi
  local release
  for release in "${NEW_RELEASES[@]:-}"; do [ -z "${release}" ] || rm -rf "${release}"; done
  if [ "${SERVICE_SNAPSHOT_DONE}" = 1 ]; then
    systemctl daemon-reload >/dev/null 2>&1
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
  [ -z "${BACKUP_DIR}" ] || rm -rf "${BACKUP_DIR}"
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
    apt-get update -y -qq || die 10 "apt-get update failed"
    env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq wireguard-tools curl ca-certificates tar coreutils openssl || die 10 "apt install failed"
    ;;
  dnf)
    dnf install -y -q wireguard-tools curl ca-certificates tar coreutils openssl || die 10 "dnf install failed"
    ;;
  yum)
    yum install -y -q epel-release || die 10 "yum epel install failed"
    yum install -y -q wireguard-tools curl ca-certificates tar coreutils openssl || die 10 "yum install failed"
    ;;
esac
command -v wg >/dev/null 2>&1 || die 10 "wireguard-tools installation failed"
command -v wg-quick >/dev/null 2>&1 || die 10 "wg-quick installation failed"

if ! modprobe wireguard 2>/dev/null; then
  [ -d "$(install_path "/sys/module/wireguard")" ] || die 11 "kernel WireGuard support is unavailable"
fi

node_major() { "$1" --version 2>/dev/null | sed -n 's/^v\([0-9][0-9]*\).*/\1/p'; }
atomic_link() {
  local target="$1" canonical="$2" temporary="${2}.new"
  if item_exists "${canonical}" && ! test -L "${canonical}"; then
    die 16 "${canonical} must be a symlink"
  fi
  rm -f "${temporary}"
  ln -s "${target}" "${temporary}"
  remember_temp "${temporary}"
  if [ "${TEST_MODE}" = 1 ]; then
    "${CLAWD_INSTALL_TEST_NODE_SOURCE:?}" -e 'require("fs").renameSync(process.argv[1], process.argv[2])' "${temporary}" "${canonical}"
  else
    mv -Tf "${temporary}" "${canonical}"
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
mkdir -p "${RELEASE_APP_FS}" "${RELEASE_NODE_FS}"
cp -a "${APP_SOURCE}/." "${RELEASE_APP_FS}/"

log "step: install-verified-node"
case "$(uname -m)" in
  x86_64|amd64) NODE_ARCH="x64" ;;
  aarch64|arm64) NODE_ARCH="arm64" ;;
  *) die 10 "unsupported Node architecture" ;;
esac
NODE_ARCHIVE="node-${NODE_RELEASE}-linux-${NODE_ARCH}.tar.gz"
NODE_URL="https://nodejs.org/dist/${NODE_RELEASE}"
test ! -L "${NODE_CACHE_DIR_FS}" || die 10 "Node cache directory is unsafe"
ensure_directory "${NODE_CACHE_DIR_FS}" 755
CACHE_EXPECTED_UID=0
if [ "${TEST_MODE}" = 1 ]; then CACHE_EXPECTED_UID="$(id -u)"; fi
NODE_CACHE_DIR_META="$(stat -c '%u:%a' "${NODE_CACHE_DIR_FS}")"
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
if test -e "${NODE_CACHE_ARCHIVE}" || test -L "${NODE_CACHE_ARCHIVE}"; then
  test -f "${NODE_CACHE_ARCHIVE}" && test ! -L "${NODE_CACHE_ARCHIVE}" ||
    die 10 "Node cache archive is unsafe"
  [ "$(stat -c '%u:%a' "${NODE_CACHE_ARCHIVE}")" = "${CACHE_EXPECTED_UID}:444" ] ||
    die 10 "Node cache archive ownership or mode is unsafe"
fi
verify_node_archive() {
  local archive="$1"
  printf '%s  %s\n' "${NODE_EXPECTED_SHA}" "${archive}" | sha256sum -c - >/dev/null 2>&1 ||
    die 10 "Node checksum verification failed"
}
if test -f "${NODE_CACHE_ARCHIVE}"; then
  verify_node_archive "${NODE_CACHE_ARCHIVE}"
else
  NODE_DOWNLOADED_ARCHIVE="${NODE_DOWNLOAD_DIR}/${NODE_ARCHIVE}"
  curl -fsSLo "${NODE_DOWNLOADED_ARCHIVE}" "${NODE_URL}/${NODE_ARCHIVE}" || die 10 "Node download failed"
  verify_node_archive "${NODE_DOWNLOADED_ARCHIVE}"
  NODE_CACHE_TMP="$(mktemp "${NODE_CACHE_DIR_FS}/.${NODE_ARCHIVE}.tmp.XXXXXX")"
  remember_temp "${NODE_CACHE_TMP}"
  cp "${NODE_DOWNLOADED_ARCHIVE}" "${NODE_CACHE_TMP}"
  chmod 444 "${NODE_CACHE_TMP}"
  mv "${NODE_CACHE_TMP}" "${NODE_CACHE_ARCHIVE}"
  NODE_CACHE_ARCHIVE_CREATED=1
fi
[ "$(stat -c '%u:%a' "${NODE_CACHE_ARCHIVE}")" = "${CACHE_EXPECTED_UID}:444" ] ||
  die 10 "Node cache archive ownership or mode is unsafe"
verify_node_archive "${NODE_CACHE_ARCHIVE}"
tar -xzf "${NODE_CACHE_ARCHIVE}" -C "${RELEASE_NODE_FS}" --strip-components=1

chmod 755 "${RELEASE_FS}" "${RELEASE_NODE_FS}"
find "${RELEASE_NODE_FS}" -type d -exec chmod 755 {} +
find "${RELEASE_APP_FS}" -type d -exec chmod 755 {} +
find "${RELEASE_APP_FS}" -type f -exec chmod 644 {} +
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
  ln -s "${CURRENT_FS}/app" "${APP_DIR_FS}"
elif test -d "${APP_DIR_FS}" && ! test -L "${APP_DIR_FS}"; then
  log "legacy app directory preserved at ${APP_DIR}"
fi
if ! item_exists "${NODE_RUNTIME_DIR_FS}"; then
  NODE_LINK_CREATED=1
  ln -s "${CURRENT_FS}/node" "${NODE_RUNTIME_DIR_FS}"
elif test -d "${NODE_RUNTIME_DIR_FS}" && ! test -L "${NODE_RUNTIME_DIR_FS}"; then
  log "legacy Node directory preserved at ${NODE_RUNTIME_DIR}"
fi
NODE_BIN_FS="${CURRENT_FS}/node/bin/node"

log "step: discover-endpoint"
ENDPOINT_HOST_VALUE="${ENDPOINT_HOST:-}"
if [ -z "${ENDPOINT_HOST_VALUE}" ]; then ENDPOINT_HOST_VALUE="$(curl -fsS --max-time 8 https://api.ipify.org 2>/dev/null || true)"; fi
if [ -z "${ENDPOINT_HOST_VALUE}" ]; then ENDPOINT_HOST_VALUE="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src"){print $(i+1); exit}}')"; fi
[ -n "${ENDPOINT_HOST_VALUE}" ] || die 17 "public endpoint discovery failed"
if ! "${NODE_BIN_FS}" - "${ENDPOINT_HOST_VALUE}" <<'NODE'
const net = require("node:net");
const host = process.argv[2];
function ipv4ToInt(value) {
  return value.split(".").reduce((result, octet) => ((result << 8) | Number(octet)) >>> 0, 0);
}
function ipv4InCidr(value, base, prefix) {
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (value & mask) === (ipv4ToInt(base) & mask);
}
function ipv6ToBigInt(value) {
  const halves = value.toLowerCase().split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) return null;
  return [...left, ...Array(missing).fill("0"), ...right]
    .reduce((result, group) => (result << 16n) | BigInt(`0x${group}`), 0n);
}
function ipv6InCidr(value, base, prefix) {
  const shift = BigInt(128 - prefix);
  return (value >> shift) === (ipv6ToBigInt(base) >> shift);
}
function globallyRoutable(value) {
  const version = net.isIP(value);
  if (version === 4) {
    if (value.split(".").some((octet) => String(Number(octet)) !== octet)) return false;
    const numeric = ipv4ToInt(value);
    return ![
      ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
      ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
      ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15],
      ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
    ].some(([base, prefix]) => ipv4InCidr(numeric, base, prefix));
  }
  if (version === 6) {
    if (value !== value.toLowerCase()) return false;
    if (new URL(`http://[${value}]/`).hostname !== `[${value}]`) return false;
    const numeric = ipv6ToBigInt(value);
    return ipv6InCidr(numeric, "2000::", 3) && ![
      ["2001::", 23], ["2001:db8::", 32], ["2002::", 16], ["3fff::", 20],
    ].some(([base, prefix]) => ipv6InCidr(numeric, base, prefix));
  }
  return false;
}
if (net.isIP(host)) process.exit(globallyRoutable(host) ? 0 : 1);
if (host !== host.toLowerCase() || host.length > 253 || /^\d+(?:\.\d+)+$/.test(host) ||
    host === "localhost" || host.endsWith(".local")) process.exit(1);
const labels = host.split(".");
if (labels.length < 2 || labels.some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) {
  process.exit(1);
}
NODE
then
  die 17 "public endpoint is invalid"
fi
case "${ENDPOINT_HOST_VALUE}" in
  *:*) ENDPOINT="[${ENDPOINT_HOST_VALUE}]:${WG_PORT}" ;;
  *) ENDPOINT="${ENDPOINT_HOST_VALUE}:${WG_PORT}" ;;
esac

log "step: generate-wireguard-keys"
mkdir -p "${WG_KEY_DIR_FS}"
chmod 700 "${WG_KEY_DIR_FS}"
generate_key_pair() {
  local name="$1" force="$2" private_path="${WG_KEY_DIR_FS}/$1.key" public_path="${WG_KEY_DIR_FS}/$1.pub"
  if [ "${force}" != 1 ] && test -s "${private_path}" && test -s "${public_path}"; then return; fi
  local private_tmp public_tmp
  private_tmp="$(mktemp "${WG_KEY_DIR_FS}/.${name}.key.tmp.XXXXXX")"; remember_temp "${private_tmp}"
  public_tmp="$(mktemp "${WG_KEY_DIR_FS}/.${name}.pub.tmp.XXXXXX")"; remember_temp "${public_tmp}"
  wg genkey | tee "${private_tmp}" >/dev/null
  sh -c "wg pubkey < '${private_tmp}' > '${public_tmp}'"
  chmod 600 "${private_tmp}" "${public_tmp}"
  mv "${private_tmp}" "${private_path}"
  mv "${public_tmp}" "${public_path}"
}
generate_key_pair server "${FORCE_RESET_ALL}"
generate_key_pair pc "${FORCE_RESET_ALL}"
generate_key_pair phone "${FORCE_RESET_ALL}"
find "${WG_KEY_DIR_FS}" -type f -exec chmod 600 {} +
checkpoint wireguard-keys

SERVER_PRIV="$(cat "${WG_KEY_DIR_FS}/server.key")"
SERVER_PUB="$(cat "${WG_KEY_DIR_FS}/server.pub")"
PC_PRIV="$(cat "${WG_KEY_DIR_FS}/pc.key")"
PC_PUB="$(cat "${WG_KEY_DIR_FS}/pc.pub")"
PHONE_PRIV="$(cat "${WG_KEY_DIR_FS}/phone.key")"
PHONE_PUB="$(cat "${WG_KEY_DIR_FS}/phone.pub")"

log "step: write-wireguard-config"
WG_CONF_TMP="$(mktemp "${WG_DIR_FS}/.clawd.tmp.XXXXXX.conf")"; remember_temp "${WG_CONF_TMP}"
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
AllowedIPs = ${PHONE_IP}/32" | tee "${WG_CONF_TMP}" >/dev/null
chmod 600 "${WG_CONF_TMP}"
wg-quick strip "${WG_CONF_TMP}" >/dev/null || die 18 "WireGuard config validation failed"
mv "${WG_CONF_TMP}" "${WG_CONF_FS}"
chmod 600 "${WG_CONF_FS}"
checkpoint wireguard-config

read_env_value() {
  local key="$1"
  if test -f "${RELAY_ENV_FS}"; then sed -n "s/^${key}=//p" "${RELAY_ENV_FS}"; fi
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
RELAY_ENV_TMP="$(mktemp "${RELAY_ETC_FS}/.relay.env.tmp.XXXXXX")"; remember_temp "${RELAY_ENV_TMP}"
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
PHONE_ROTATION_JOURNAL_PATH=${RELAY_ETC}/phone-rotation.journal
RELAY_ENV_PATH=${RELAY_ENV}" | tee "${RELAY_ENV_TMP}" >/dev/null
chmod 600 "${RELAY_ENV_TMP}"
mv "${RELAY_ENV_TMP}" "${RELAY_ENV_FS}"
chmod 600 "${RELAY_ENV_FS}"
checkpoint relay-environment

log "step: write-systemd-unit"
UNIT_TMP="$(mktemp "$(dirname "${UNIT_FS}")/.clawd-relay.service.tmp.XXXXXX")"; remember_temp "${UNIT_TMP}"
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
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true
ProtectSystem=strict
ReadWritePaths=/etc/clawd-relay /etc/wireguard /run/lock
CapabilityBoundingSet=CAP_NET_ADMIN
AmbientCapabilities=CAP_NET_ADMIN

[Install]
WantedBy=multi-user.target" | tee "${UNIT_TMP}" >/dev/null
chmod 644 "${UNIT_TMP}"
mv "${UNIT_TMP}" "${UNIT_FS}"
checkpoint systemd-unit

log "step: firewall"
NEW_FIREWALL_BACKEND=""
NEW_FIREWALL_IPV4=0
NEW_FIREWALL_IPV6=0
NEW_FIREWALL_UNIT=0
inherit_firewall_ownership() {
  if [ "${OLD_FIREWALL_BACKEND}" = "$1" ] && [ "${OLD_FIREWALL_PORT}" = "${WG_PORT}" ]; then
    NEW_FIREWALL_IPV4="${OLD_FIREWALL_IPV4}"
    NEW_FIREWALL_IPV6="${OLD_FIREWALL_IPV6}"
    NEW_FIREWALL_UNIT="${OLD_FIREWALL_UNIT}"
  fi
}
UFW_STATUS=""
if command -v ufw >/dev/null 2>&1; then
  UFW_STATUS="$(ufw status 2>/dev/null || true)"
fi
if printf '%s\n' "${UFW_STATUS}" | awk '$1 == "Status:" && $2 == "active" { found=1 } END { exit !found }'; then
  NEW_FIREWALL_BACKEND=ufw
  inherit_firewall_ownership ufw
  UFW_V4=0
  UFW_V6=0
  printf '%s\n' "${UFW_STATUS}" | awk -v rule="${WG_PORT}/udp" '$1 == rule && $2 == "ALLOW" { found=1 } END { exit !found }' && UFW_V4=1
  printf '%s\n' "${UFW_STATUS}" | awk -v rule="${WG_PORT}/udp" '$1 == rule && $2 == "(v6)" && $3 == "ALLOW" { found=1 } END { exit !found }' && UFW_V6=1
  if [ "${UFW_V4}" != "${UFW_V6}" ]; then
    die 14 "ufw has partial address-family coverage"
  fi
  if [ "${UFW_V4}" = 0 ]; then
    ufw allow "${WG_PORT}/udp" >/dev/null || die 14 "ufw update failed"
    FIREWALL_ADDED=ufw
    NEW_FIREWALL_IPV4=1
    NEW_FIREWALL_IPV6=1
    UFW_STATUS="$(ufw status)"
    printf '%s\n' "${UFW_STATUS}" | awk -v rule="${WG_PORT}/udp" '$1 == rule && $2 == "ALLOW" { found=1 } END { exit !found }' ||
      die 14 "ufw IPv4 rule verification failed"
    printf '%s\n' "${UFW_STATUS}" | awk -v rule="${WG_PORT}/udp" '$1 == rule && $2 == "(v6)" && $3 == "ALLOW" { found=1 } END { exit !found }' ||
      die 14 "ufw IPv6 rule verification failed"
  fi
elif command -v firewall-cmd >/dev/null 2>&1 && firewall-cmd --state >/dev/null 2>&1; then
  NEW_FIREWALL_BACKEND=firewalld
  inherit_firewall_ownership firewalld
  FIREWALLD_ADDED=0
  if ! firewall-cmd --permanent --query-port="${WG_PORT}/udp" >/dev/null 2>&1; then
    firewall-cmd --permanent --add-port="${WG_PORT}/udp" >/dev/null || die 14 "firewalld update failed"
    FIREWALL_ADDED=firewalld
    FIREWALLD_ADDED=1
    NEW_FIREWALL_IPV4=1
    NEW_FIREWALL_IPV6=1
  fi
  if [ "${FIREWALLD_ADDED}" = 1 ] ||
    ! firewall-cmd --query-port="${WG_PORT}/udp" >/dev/null 2>&1; then
    firewall-cmd --reload >/dev/null || die 14 "firewalld reload failed"
  fi
  firewall-cmd --permanent --query-port="${WG_PORT}/udp" >/dev/null 2>&1 ||
    die 14 "firewalld permanent rule verification failed"
  firewall-cmd --query-port="${WG_PORT}/udp" >/dev/null 2>&1 ||
    die 14 "firewalld runtime rule verification failed"
elif command -v iptables >/dev/null 2>&1 && command -v ip6tables >/dev/null 2>&1; then
  NEW_FIREWALL_BACKEND=iptables
  inherit_firewall_ownership iptables
  IPTABLES_BIN="$(command -v iptables)"
  IP6TABLES_BIN="$(command -v ip6tables)"
  FIREWALL_ADDED=iptables
  if ! iptables -C INPUT -p udp --dport "${WG_PORT}" -j ACCEPT 2>/dev/null; then
    iptables -A INPUT -p udp --dport "${WG_PORT}" -j ACCEPT || die 14 "iptables update failed"
    IPTABLES4_ADDED=1
    NEW_FIREWALL_IPV4=1
  fi
  if ! ip6tables -C INPUT -p udp --dport "${WG_PORT}" -j ACCEPT 2>/dev/null; then
    ip6tables -A INPUT -p udp --dport "${WG_PORT}" -j ACCEPT || die 14 "ip6tables update failed"
    IPTABLES6_ADDED=1
    NEW_FIREWALL_IPV6=1
  fi
  iptables -C INPUT -p udp --dport "${WG_PORT}" -j ACCEPT 2>/dev/null ||
    die 14 "iptables rule verification failed"
  ip6tables -C INPUT -p udp --dport "${WG_PORT}" -j ACCEPT 2>/dev/null ||
    die 14 "ip6tables rule verification failed"
  FIREWALL_UNIT_TMP="$(mktemp "$(dirname "${FIREWALL_UNIT_FS}")/.clawd-relay-firewall.service.tmp.XXXXXX")"
  remember_temp "${FIREWALL_UNIT_TMP}"
  printf '%s\n' "[Unit]
Description=Persist Clawd WireGuard firewall rules
Before=wg-quick@${IFACE}.service

[Service]
Type=oneshot
ExecStart=/bin/sh -ec '${IPTABLES_BIN} -C INPUT -p udp --dport ${WG_PORT} -j ACCEPT || ${IPTABLES_BIN} -A INPUT -p udp --dport ${WG_PORT} -j ACCEPT; ${IP6TABLES_BIN} -C INPUT -p udp --dport ${WG_PORT} -j ACCEPT || ${IP6TABLES_BIN} -A INPUT -p udp --dport ${WG_PORT} -j ACCEPT'
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target" | tee "${FIREWALL_UNIT_TMP}" >/dev/null
  chmod 644 "${FIREWALL_UNIT_TMP}"
  mv "${FIREWALL_UNIT_TMP}" "${FIREWALL_UNIT_FS}"
  systemctl daemon-reload || die 14 "firewall service reload failed"
  systemctl enable clawd-relay-firewall.service >/dev/null || die 14 "firewall service enable failed"
  systemctl restart clawd-relay-firewall.service || die 14 "firewall service start failed"
  systemctl is-enabled --quiet clawd-relay-firewall.service || die 14 "firewall service is not enabled"
  systemctl is-active --quiet clawd-relay-firewall.service || die 14 "firewall service is not active"
  NEW_FIREWALL_UNIT=1
else
  die 14 "no supported firewall backend"
fi

FIREWALL_METADATA_TMP="$(mktemp "${RELAY_ETC_FS}/.firewall.env.tmp.XXXXXX")"
remember_temp "${FIREWALL_METADATA_TMP}"
printf '%s\n' "BACKEND=${NEW_FIREWALL_BACKEND}
PORT=${WG_PORT}
IPV4=${NEW_FIREWALL_IPV4}
IPV6=${NEW_FIREWALL_IPV6}
UNIT=${NEW_FIREWALL_UNIT}" | tee "${FIREWALL_METADATA_TMP}" >/dev/null
chmod 600 "${FIREWALL_METADATA_TMP}"
mv "${FIREWALL_METADATA_TMP}" "${FIREWALL_METADATA_FS}"
chmod 600 "${FIREWALL_METADATA_FS}"
"${NODE_BIN_FS}" -e '
  const fs = require("node:fs");
  for (const target of process.argv.slice(1)) {
    const descriptor = fs.openSync(target, "r");
    try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
  }
' "${FIREWALL_METADATA_FS}" "${RELAY_ETC_FS}"
checkpoint firewall-rule

log "step: enable-and-verify-services"
systemctl daemon-reload || die 20 "systemd reload failed"
systemctl enable "wg-quick@${IFACE}" >/dev/null || die 20 "WireGuard enable failed"
systemctl restart "wg-quick@${IFACE}" || die 20 "WireGuard start failed"
systemctl is-enabled --quiet "wg-quick@${IFACE}" || die 20 "WireGuard is not enabled"
systemctl is-active --quiet "wg-quick@${IFACE}" || die 20 "WireGuard is not active"
checkpoint wireguard-service
systemctl enable clawd-relay.service >/dev/null || die 20 "Relay enable failed"
systemctl restart clawd-relay.service || die 20 "Relay start failed"
systemctl is-enabled --quiet clawd-relay.service || die 20 "Relay is not enabled"
systemctl is-active --quiet clawd-relay.service || die 20 "Relay is not active"
checkpoint relay-service

probe_relay_service() {
  local probe_host="${SERVER_IP}" probe_port="${RELAY_PORT}"
  local probe_env="${RELAY_ENV}" probe_ws="${CURRENT}/app/node_modules/ws"
  local probe_attempts=40 probe_delay_ms=250
  if [ "${TEST_MODE}" = 1 ]; then
    probe_host="$(cat "${CLAWD_INSTALL_TEST_STATE:?}/relay-probe-host")"
    probe_port="$(cat "${CLAWD_INSTALL_TEST_STATE:?}/relay-probe-port")"
    probe_env="${RELAY_ENV_FS}"
    probe_ws="${CURRENT_FS}/app/node_modules/ws"
    probe_attempts=80
    probe_delay_ms=25
  fi
  if ! "${NODE_BIN_FS}" - "${probe_host}" "${probe_port}" "${probe_env}" "${probe_ws}" \
    "${probe_attempts}" "${probe_delay_ms}" <<'NODE'
"use strict";
const fs = require("node:fs");
const http = require("node:http");
const [host, portText, envPath, wsPath, attemptsText, delayText] = process.argv.slice(2);
const port = Number(portText);
const attempts = Number(attemptsText);
const retryDelayMs = Number(delayText);
const values = Object.create(null);
for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
  if (!line) continue;
  const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
  if (!match || Object.hasOwn(values, match[1])) throw new Error("invalid probe environment");
  values[match[1]] = match[2];
}
if (!/^[0-9a-fA-F]{64}$/.test(values.RELAY_TOKEN || "") ||
    !/^[0-9a-fA-F]{64}$/.test(values.MANAGEMENT_TOKEN || "")) {
  throw new Error("invalid probe credentials");
}
const WebSocket = require(wsPath);
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
function health() {
  return new Promise((resolve, reject) => {
    const request = http.get({ host, port, path: "/health", timeout: 750 }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        body += chunk;
        if (Buffer.byteLength(body) > 4096) request.destroy(new Error("health response too large"));
      });
      response.on("end", () => {
        try {
          const parsed = JSON.parse(body);
          if (response.statusCode !== 200 || parsed.version !== 1 || parsed.status !== "ok" ||
              typeof parsed.uptimeSeconds !== "number" || body.includes(values.RELAY_TOKEN) ||
              body.includes(values.MANAGEMENT_TOKEN)) throw new Error("invalid health response");
          resolve();
        } catch (error) { reject(error); }
      });
    });
    request.once("timeout", () => request.destroy(new Error("health timeout")));
    request.once("error", reject);
  });
}
function websocketProbe(authorization, expectedUnauthorized) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const options = authorization ? { headers: { Authorization: `Bearer ${authorization}` } } : {};
    const socket = new WebSocket(`ws://${host}:${port}/mobile/ws?role=phone`, options);
    const timer = setTimeout(() => finish(new Error("WebSocket probe timeout")), 2000);
    function finish(error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket.terminate(); } catch {}
      if (error) reject(error); else resolve();
    }
    socket.once("unexpected-response", (_request, response) => {
      response.resume();
      finish(expectedUnauthorized && response.statusCode === 401
        ? null
        : new Error("unexpected authentication response"));
    });
    socket.once("open", () => finish(expectedUnauthorized ? new Error("missing Bearer upgraded") : null));
    socket.once("error", (error) => {
      if (!expectedUnauthorized) finish(error);
    });
  });
}
(async () => {
  let failure;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try { await health(); failure = null; break; }
    catch (error) { failure = error; await delay(retryDelayMs); }
  }
  if (failure) throw failure;
  await websocketProbe(null, true);
  await websocketProbe(values.RELAY_TOKEN, false);
})().catch(() => {
  process.stderr.write("Relay health/authentication probe failed\n");
  process.exitCode = 1;
});
NODE
  then
    return 1
  fi
  if [ "${TEST_MODE}" = 1 ]; then
    printf 'health+strict-bearer\n' > "${CLAWD_INSTALL_TEST_STATE:?}/relay-smoke-ok"
  fi
}

verify_relay_stability() {
  local interval=1 attempt baseline current
  if [ "${TEST_MODE}" = 1 ]; then interval=0.02; fi
  relay_service_identity() {
    local output main_pid restart_count
    output="$(systemctl show --property=MainPID --property=NRestarts --value clawd-relay.service)" ||
      return 1
    main_pid="$(printf '%s\n' "${output}" | sed -n '1p')"
    restart_count="$(printf '%s\n' "${output}" | sed -n '2p')"
    [[ "${main_pid}" =~ ^[1-9][0-9]*$ ]] && [[ "${restart_count}" =~ ^[0-9]+$ ]] || return 1
    printf '%s:%s' "${main_pid}" "${restart_count}"
  }
  baseline="$(relay_service_identity)" || die 20 "Relay service identity is unavailable"
  for attempt in 1 2 3; do
    sleep "${interval}"
    systemctl is-enabled --quiet clawd-relay.service || die 20 "Relay became disabled"
    systemctl is-active --quiet clawd-relay.service || die 20 "Relay failed stability verification"
    current="$(relay_service_identity)" || die 20 "Relay service identity is unavailable"
    [ "${current}" = "${baseline}" ] || die 20 "Relay restarted during stability verification"
  done
}

probe_relay_service || die 20 "Relay probe failed"
verify_relay_stability

remove_obsolete_firewall
checkpoint firewall-migration

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
  [ -z "${old_release}" ] || [ "${old_release}" = "${RELEASE_FS}" ] || rm -rf "${old_release}"
done
log "done"
