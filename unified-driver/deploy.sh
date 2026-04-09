#!/usr/bin/env bash
set -euo pipefail

SERVER="47.239.165.86"
REMOTE_DIR="/root/web_driver_mouse/unified-driver"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "==> Creating remote directory..."
ssh root@${SERVER} "mkdir -p ${REMOTE_DIR}"

echo "==> Syncing files to server..."
rsync -avz --delete \
  --exclude 'node_modules' \
  --exclude '.git' \
  "${SCRIPT_DIR}/" root@${SERVER}:${REMOTE_DIR}/

echo "==> Building and starting containers..."
ssh root@${SERVER} << 'ENDSSH'
cd /root/web_driver_mouse/unified-driver
docker compose down 2>/dev/null || true
docker compose up -d --build
ENDSSH

echo "==> Configuring nginx..."
ssh root@${SERVER} << 'ENDSSH'
cp /root/web_driver_mouse/unified-driver/nginx-mouse.conf /etc/nginx/conf.d/mouse.wwwneo.com.conf
nginx -t && nginx -s reload
ENDSSH

echo ""
echo "==> Deployment complete!"
echo "==> Site available at: https://mouse.wwwneo.com"
