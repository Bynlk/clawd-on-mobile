#!/usr/bin/env bash
# relay/deploy-relay.sh — 一键部署 Clawd 中继服务器
# 用法: ./deploy-relay.sh [docker|systemd]
#   docker  — 使用 Docker Compose 部署（默认）
#   systemd — 使用 systemd 服务部署

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DEPLOY_MODE="${1:-docker}"
PORT="${PORT:-7891}"

# 颜色
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log() { echo -e "${GREEN}[relay]${NC} $*"; }
warn() { echo -e "${YELLOW}[relay]${NC} $*"; }
err() { echo -e "${RED}[relay]${NC} $*" >&2; }

# 生成随机 token
generate_token() {
  openssl rand -hex 16
}

# 检查依赖
check_deps() {
  if [ "$DEPLOY_MODE" = "docker" ]; then
    if ! command -v docker &>/dev/null; then
      err "未找到 docker，请先安装 Docker"
      exit 1
    fi
    if ! command -v docker-compose &>/dev/null && ! docker compose version &>/dev/null; then
      err "未找到 docker-compose，请先安装 Docker Compose"
      exit 1
    fi
  elif [ "$DEPLOY_MODE" = "systemd" ]; then
    if ! command -v node &>/dev/null; then
      err "未找到 node，请先安装 Node.js >= 18"
      exit 1
    fi
    if ! command -v systemctl &>/dev/null; then
      err "未找到 systemctl，此模式仅支持 systemd 系统"
      exit 1
    fi
  else
    err "未知部署模式: $DEPLOY_MODE (支持 docker / systemd)"
    exit 1
  fi
}

# 生成配置文件
generate_config() {
  local config_dir="$1"
  local connection_token="${2:-$(generate_token)}"
  local admin_token="${3:-$(generate_token)}"

  cat > "$config_dir/.env" <<EOF
# Clawd Relay Server 配置
# 生成时间: $(date -Iseconds)
PORT=${PORT}
TOKEN=${connection_token}
ADMIN_TOKEN=${admin_token}
EOF

  chmod 600 "$config_dir/.env"
  log "配置已写入 $config_dir/.env"
  echo ""
  echo "=========================================="
  echo "  Connection Token: ${connection_token}"
  echo "  Admin Token:      ${admin_token}"
  echo "  Port:             ${PORT}"
  echo "=========================================="
  echo ""
  warn "请保存以上 token！Connection Token 用于 PC/Android 连接，Admin Token 用于 REST API 控制。"
}

# Docker 部署
deploy_docker() {
  log "使用 Docker Compose 部署..."

  local config_dir="$SCRIPT_DIR"
  generate_config "$config_dir"

  # 复制 docker-compose.yml 到当前目录（如果不存在）
  if [ ! -f "$config_dir/docker-compose.yml" ]; then
    err "未找到 docker-compose.yml"
    exit 1
  fi

  cd "$config_dir"
  if docker compose version &>/dev/null; then
    docker compose up -d
  else
    docker-compose up -d
  fi

  log "Docker 部署完成！"
  log "查看日志: docker compose logs -f clawd-relay"
  log "停止服务: docker compose down"
}

# systemd 部署
deploy_systemd() {
  log "使用 systemd 部署..."

  local config_dir="/etc/clawd-relay"
  local service_file="/etc/systemd/system/clawd-relay.service"

  # 创建配置目录
  sudo mkdir -p "$config_dir"
  generate_config "$config_dir"

  # 复制 relay server
  sudo cp "$SCRIPT_DIR/relay-server.js" "$config_dir/relay-server.js"
  sudo cp "$SCRIPT_DIR/package.json" "$config_dir/package.json" 2>/dev/null || true

  # 安装依赖
  cd "$config_dir"
  if [ -f package.json ]; then
    sudo npm install --production
  fi

  # 创建 systemd 服务文件
  sudo tee "$service_file" > /dev/null <<EOF
[Unit]
Description=Clawd Relay Server
After=network.target

[Service]
Type=simple
User=nobody
Group=nogroup
WorkingDirectory=$config_dir
EnvironmentFile=$config_dir/.env
ExecStart=$(which node) $config_dir/relay-server.js
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

  sudo systemctl daemon-reload
  sudo systemctl enable clawd-relay
  sudo systemctl start clawd-relay

  log "systemd 部署完成！"
  log "查看日志: journalctl -u clawd-relay -f"
  log "停止服务: sudo systemctl stop clawd-relay"
  log "重启服务: sudo systemctl restart clawd-relay"
}

# 主流程
check_deps

echo ""
log "开始部署 Clawd 中继服务器..."
echo ""

if [ "$DEPLOY_MODE" = "docker" ]; then
  deploy_docker
else
  deploy_systemd
fi

echo ""
log "部署完成！"
echo ""
echo "下一步:"
echo "  1. 将 Connection Token 填入 PC 端 Settings → Mobile → Remote Relay"
echo "  2. 将 Connection Token 填入 Android 端 Settings → Relay"
echo "  3. 如果使用自签证书，需要在 Android 上手动安装 CA 证书"
echo ""
