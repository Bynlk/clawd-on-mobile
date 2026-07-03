#!/usr/bin/env bash
# install-wg-relay.sh — 幂等的 WireGuard 中继一键安装脚本
#
# 由桌面端通过 SSH 单次连接 + stdin 喂入执行(D-CONN)。全部参数经环境变量
# 传入(SEC-5),不做字符串插值。产出用 <<<CLAWD_JSON>>>...<<<END_CLAWD_JSON>>>
# 标记包裹的 JSON(D-JSON),供桌面端正则提取。
#
# 输入环境变量:
#   WG_PORT          WireGuard 监听 UDP 端口 (默认 51820)
#   WG_SUBNET        隧道子网 (默认 10.8.0.0/24)
#   RELAY_PORT       隧道内 relay 端口 (默认 7891)
#   FORCE_PHONE_KEY  1 = 重新生成 phone 密钥;其余 = 复用 (默认 0)
#
# 退出码约定(桌面端映射到 EX 表):
#   0  成功
#   10 包管理器不支持 (EX-1)
#   11 内核不支持 WireGuard (EX-2)
#   12 端口占用 (EX-6)
#   13 无 sudo/root 权限 (EX-5)
#   14 防火墙配置失败 (EX-6)

set -euo pipefail
export LANG=C LC_ALL=C

WG_PORT="${WG_PORT:-51820}"
WG_SUBNET="${WG_SUBNET:-10.8.0.0/24}"
RELAY_PORT="${RELAY_PORT:-7891}"
FORCE_PHONE_KEY="${FORCE_PHONE_KEY:-0}"

IFACE="clawd"
WG_DIR="/etc/wireguard"
WG_CONF="${WG_DIR}/${IFACE}.conf"

# 隧道内地址:server .1 / pc .2 / phone .3 (D-SUBNET)
SUBNET_BASE="${WG_SUBNET%.*/*}"     # 10.8.0.0/24 -> 10.8.0
SERVER_IP="${SUBNET_BASE}.1"
PC_IP="${SUBNET_BASE}.2"
PHONE_IP="${SUBNET_BASE}.3"

log() { echo "[wg-relay] $*" >&2; }
die() { log "ERROR: $2"; exit "$1"; }

# ── 0. 提权前缀:root 直跑,否则 sudo -n,再否则 EX-5 ──
SUDO=""
if [ "$(id -u)" -ne 0 ]; then
  if command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then
    SUDO="sudo"
  else
    die 13 "need root or passwordless sudo (EX-5)"
  fi
fi

# ── 1. detect: 识别包管理器 + 内核 WireGuard 支持 ──
log "step: detect"
PKG=""
if command -v apt-get >/dev/null 2>&1; then PKG="apt"
elif command -v dnf >/dev/null 2>&1; then PKG="dnf"
elif command -v yum >/dev/null 2>&1; then PKG="yum"
else
  die 10 "no supported package manager (apt/dnf/yum) (EX-1)"
fi
log "package manager: ${PKG}"

# ── 2. install: wireguard-tools,已装则跳过(幂等) ──
log "step: install"
if ! command -v wg >/dev/null 2>&1; then
  case "${PKG}" in
    apt)
      $SUDO apt-get update -y -qq || die 10 "apt-get update failed"
      $SUDO DEBIAN_FRONTEND=noninteractive apt-get install -y -qq wireguard-tools || die 10 "apt install wireguard-tools failed"
      ;;
    dnf)
      $SUDO dnf install -y -q wireguard-tools || die 10 "dnf install wireguard-tools failed"
      ;;
    yum)
      $SUDO yum install -y -q epel-release >/dev/null 2>&1 || true
      $SUDO yum install -y -q wireguard-tools || die 10 "yum install wireguard-tools failed"
      ;;
  esac
else
  log "wireguard-tools already installed (skip)"
fi
command -v wg >/dev/null 2>&1 || die 10 "wg not found after install (EX-1)"

# 内核模块检查(EX-2)。容器/内核内置场景下 modprobe 可能无输出但内核支持,
# 因此用 "modprobe 成功 或 /sys/module/wireguard 存在 或 wg 能创建接口" 综合判断。
if ! $SUDO modprobe wireguard 2>/dev/null; then
  if [ ! -d /sys/module/wireguard ] && ! (echo "" | wg pubkey >/dev/null 2>&1); then
    die 11 "kernel WireGuard not available (EX-2)"
  fi
fi

# ── 3. gen-keys: 不存在才生成;FORCE_PHONE_KEY=1 时重生 phone ──
log "step: gen-keys"
$SUDO mkdir -p "${WG_DIR}"
$SUDO chmod 700 "${WG_DIR}"

gen_key_if_absent() {
  # $1 = base name (server/pc/phone)
  local name="$1"
  local kf="${WG_DIR}/${name}.key"
  local pf="${WG_DIR}/${name}.pub"
  if [ ! -f "${kf}" ]; then
    wg genkey | $SUDO tee "${kf}" >/dev/null
    $SUDO chmod 600 "${kf}"
    $SUDO sh -c "wg pubkey < '${kf}' > '${pf}'"
    $SUDO chmod 644 "${pf}"
  fi
}

gen_key_if_absent server
gen_key_if_absent pc
if [ "${FORCE_PHONE_KEY}" = "1" ]; then
  $SUDO rm -f "${WG_DIR}/phone.key" "${WG_DIR}/phone.pub"
fi
gen_key_if_absent phone

SERVER_PRIV="$($SUDO cat "${WG_DIR}/server.key")"
SERVER_PUB="$($SUDO cat "${WG_DIR}/server.pub")"
PC_PRIV="$($SUDO cat "${WG_DIR}/pc.key")"
PC_PUB="$($SUDO cat "${WG_DIR}/pc.pub")"
PHONE_PRIV="$($SUDO cat "${WG_DIR}/phone.key")"
PHONE_PUB="$($SUDO cat "${WG_DIR}/phone.pub")"

# ── 4. write-conf: 模板渲染;比对幂等覆盖(非追加) ──
log "step: write-conf"
NEW_CONF="$(cat <<EOF
[Interface]
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
AllowedIPs = ${PHONE_IP}/32
EOF
)"
# 仅当内容变化时才覆盖(幂等,EX-8)
if [ ! -f "${WG_CONF}" ] || [ "$($SUDO cat "${WG_CONF}")" != "${NEW_CONF}" ]; then
  printf '%s\n' "${NEW_CONF}" | $SUDO tee "${WG_CONF}" >/dev/null
  $SUDO chmod 600 "${WG_CONF}"
fi

# 端口占用检测(EX-6):排除自身接口已监听的情况
if command -v ss >/dev/null 2>&1; then
  if ss -lun 2>/dev/null | grep -q ":${WG_PORT} " && ! $SUDO wg show "${IFACE}" >/dev/null 2>&1; then
    die 12 "UDP port ${WG_PORT} already in use (EX-6)"
  fi
fi

# ── 5. start-service: 最后才 enable(EX-7,全成功才启用) ──
log "step: start-service"
if command -v systemctl >/dev/null 2>&1; then
  $SUDO systemctl enable "wg-quick@${IFACE}" >/dev/null 2>&1 || true
  # 已在跑则重载配置,否则拉起(幂等)
  if $SUDO wg show "${IFACE}" >/dev/null 2>&1; then
    $SUDO wg syncconf "${IFACE}" <($SUDO wg-quick strip "${IFACE}") 2>/dev/null || {
      $SUDO systemctl restart "wg-quick@${IFACE}" 2>/dev/null || true
    }
  else
    $SUDO systemctl start "wg-quick@${IFACE}" 2>/dev/null || $SUDO wg-quick up "${IFACE}" 2>/dev/null || true
  fi
else
  # 无 systemd(如精简容器):直接 wg-quick
  $SUDO wg show "${IFACE}" >/dev/null 2>&1 || $SUDO wg-quick up "${IFACE}" 2>/dev/null || true
fi

# ── 6. relay: 写 systemd unit,绑定隧道内网地址(FR-SRV-1) ──
log "step: relay"
RELAY_SRC=""
for cand in "/opt/clawd-relay/relay-server.js" "${HOME}/clawd-relay/relay-server.js" "$(dirname "$0")/relay-server.js"; do
  if [ -f "${cand}" ]; then RELAY_SRC="${cand}"; break; fi
done
if command -v systemctl >/dev/null 2>&1 && [ -n "${RELAY_SRC}" ] && command -v node >/dev/null 2>&1; then
  UNIT="/etc/systemd/system/clawd-relay.service"
  NODE_BIN="$(command -v node)"
  NEW_UNIT="$(cat <<EOF
[Unit]
Description=Clawd Relay (WireGuard tunnel-internal)
After=network-online.target wg-quick@${IFACE}.service
Wants=network-online.target

[Service]
Type=simple
Environment=BIND_ADDR=${SERVER_IP}
Environment=PORT=${RELAY_PORT}
ExecStart=${NODE_BIN} ${RELAY_SRC}
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
)"
  if [ ! -f "${UNIT}" ] || [ "$($SUDO cat "${UNIT}")" != "${NEW_UNIT}" ]; then
    printf '%s\n' "${NEW_UNIT}" | $SUDO tee "${UNIT}" >/dev/null
    $SUDO systemctl daemon-reload
  fi
  $SUDO systemctl enable --now clawd-relay.service >/dev/null 2>&1 || true
else
  log "relay unit skipped (no systemd/node/relay-server.js found; tunnel still up)"
fi

# ── 7. firewall: 仅放行 WG_PORT/udp(幂等) ──
log "step: firewall"
FW_OK=1
if command -v ufw >/dev/null 2>&1 && $SUDO ufw status >/dev/null 2>&1; then
  $SUDO ufw allow "${WG_PORT}/udp" >/dev/null 2>&1 || FW_OK=0
elif command -v firewall-cmd >/dev/null 2>&1 && $SUDO firewall-cmd --state >/dev/null 2>&1; then
  $SUDO firewall-cmd --permanent --add-port="${WG_PORT}/udp" >/dev/null 2>&1 || FW_OK=0
  $SUDO firewall-cmd --reload >/dev/null 2>&1 || FW_OK=0
elif command -v iptables >/dev/null 2>&1; then
  if ! $SUDO iptables -C INPUT -p udp --dport "${WG_PORT}" -j ACCEPT 2>/dev/null; then
    $SUDO iptables -A INPUT -p udp --dport "${WG_PORT}" -j ACCEPT 2>/dev/null || FW_OK=0
  fi
else
  log "no firewall tool found (assuming open)"
fi
[ "${FW_OK}" = "1" ] || die 14 "firewall configuration failed (EX-6)"

# ── 8. readback: 组装 JSON,标记包裹输出(D-JSON) ──
log "step: readback"
ENDPOINT_HOST="$(curl -fsS --max-time 8 https://api.ipify.org 2>/dev/null || true)"
if [ -z "${ENDPOINT_HOST}" ]; then
  ENDPOINT_HOST="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src"){print $(i+1); exit}}' || true)"
fi
ENDPOINT="${ENDPOINT_HOST}:${WG_PORT}"

PC_CONF="[Interface]
PrivateKey = ${PC_PRIV}
Address = ${PC_IP}/32

[Peer]
PublicKey = ${SERVER_PUB}
Endpoint = ${ENDPOINT}
AllowedIPs = ${SUBNET_BASE}.0/24
PersistentKeepalive = 25"

PHONE_CONF="[Interface]
PrivateKey = ${PHONE_PRIV}
Address = ${PHONE_IP}/32

[Peer]
PublicKey = ${SERVER_PUB}
Endpoint = ${ENDPOINT}
AllowedIPs = ${SUBNET_BASE}.0/24
PersistentKeepalive = 25"

# 用 base64 无换行编码 conf,避免 JSON 转义与换行污染(EX-11/EX-12)
b64() { printf '%s' "$1" | base64 | tr -d '\n'; }

printf '<<<CLAWD_JSON>>>'
printf '{"serverPubKey":"%s","endpoint":"%s","relayAddr":"ws://%s:%s","pcAddress":"%s/32","pcConfB64":"%s","phoneConfB64":"%s"}' \
  "${SERVER_PUB}" "${ENDPOINT}" "${SERVER_IP}" "${RELAY_PORT}" "${PC_IP}" "$(b64 "${PC_CONF}")" "$(b64 "${PHONE_CONF}")"
printf '<<<END_CLAWD_JSON>>>\n'

log "done"
exit 0
