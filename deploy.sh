#!/usr/bin/env bash
# Deploy dot-lib to a remote server: build here, rsync, restart the systemd
# service.
#
# Usage:
#   DEPLOY_HOST=ubuntu@your-server ./deploy.sh
#   DEPLOY_HOST=seoul-deploy DEPLOY_PATH=dot-lib SERVICE=dot-lib ./deploy.sh
#
# Requirements on the server: node 22+ and passwordless sudo for systemctl.
# The frontend is built locally on purpose — epub.js and pdf.js are
# devDependencies that end up inside dist/, so the server never runs vite and
# only needs the runtime deps. That keeps small (1–2 GB) boxes out of trouble.
#
# The server-side .env is NOT overwritten if it already exists; on first
# deploy it is seeded from your local .env (which must exist).
#
# Object storage: when the server runs ai-space, declare the bucket in
# space.yaml and let ai-space write BLOB_URL + S3_* into
# ~/.ai-space/data/dot-lib/space.env (the unit loads it). Then .env only needs
# PORT. Without ai-space the R2_* variables in .env keep working.
# The unit file is only installed on the first deploy; after changing
# deploy/dot-lib.service, re-install it by hand (see README).
set -euo pipefail

DEPLOY_HOST="${DEPLOY_HOST:?set DEPLOY_HOST, e.g. DEPLOY_HOST=ubuntu@1.2.3.4 ./deploy.sh}"
DEPLOY_PATH="${DEPLOY_PATH:-.awesome-agent/projects/dot-lib}"   # relative paths are under the remote home
SERVICE="${SERVICE:-dot-lib}"

echo "==> Building locally"
npm run build

echo "==> Syncing to ${DEPLOY_HOST}:${DEPLOY_PATH}"
ssh "$DEPLOY_HOST" "mkdir -p '$DEPLOY_PATH'"
rsync -az --delete \
  --exclude node_modules \
  --exclude .git \
  --exclude .env \
  --exclude .DS_Store \
  --exclude '._*' \
  ./ "$DEPLOY_HOST:$DEPLOY_PATH/"

echo "==> Ensuring server .env exists"
if ssh "$DEPLOY_HOST" "test -f '$DEPLOY_PATH/.env'"; then
  echo "    server .env already present, keeping it"
else
  [ -f .env ] || { echo "ERROR: no local .env to seed the server with (copy .env.example)"; exit 1; }
  scp .env "$DEPLOY_HOST:$DEPLOY_PATH/.env"
fi

echo "==> Installing runtime dependencies"
ssh "$DEPLOY_HOST" "cd '$DEPLOY_PATH' && npm install --omit=dev --no-audit --no-fund"

if ssh "$DEPLOY_HOST" "systemctl cat '${SERVICE}.service'" >/dev/null 2>&1; then
  echo "==> systemd unit ${SERVICE}.service already installed"
else
  echo "==> Installing systemd unit ${SERVICE}.service"
  remote_user=$(ssh "$DEPLOY_HOST" "whoami")
  remote_dir=$(ssh "$DEPLOY_HOST" "cd '$DEPLOY_PATH' && pwd")
  remote_home=$(ssh "$DEPLOY_HOST" 'echo "$HOME"')
  sed -e "s|@USER@|${remote_user}|g" -e "s|@DIR@|${remote_dir}|g" -e "s|@HOME@|${remote_home}|g" deploy/dot-lib.service |
    ssh "$DEPLOY_HOST" "sudo tee /etc/systemd/system/${SERVICE}.service >/dev/null"
  ssh "$DEPLOY_HOST" "sudo systemctl daemon-reload && sudo systemctl enable '${SERVICE}'"
fi

echo "==> Restarting ${SERVICE}"
ssh "$DEPLOY_HOST" "sudo systemctl restart '${SERVICE}'"
sleep 4

echo "==> Health check"
port=$(ssh "$DEPLOY_HOST" "grep -E '^PORT=' '$DEPLOY_PATH/.env' | tail -1 | cut -d= -f2" || true)
port="${port:-8787}"
code=$(ssh "$DEPLOY_HOST" "curl -s -o /dev/null -w '%{http_code}' 'http://127.0.0.1:${port}/api/books'" || true)
if [ "$code" = "200" ]; then
  echo "    OK — /api/books returned 200 on port ${port}"
else
  echo "    FAILED — /api/books returned '${code}'"
  ssh "$DEPLOY_HOST" "journalctl -u '${SERVICE}' -n 20 --no-pager"
  exit 1
fi

echo "==> Done. Logs: ssh $DEPLOY_HOST 'journalctl -u ${SERVICE} -f'"
