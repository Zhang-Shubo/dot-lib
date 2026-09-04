#!/usr/bin/env bash
# Deploy dot-lib to a remote server: build here, rsync, (re)install the
# user-level systemd unit, restart, health check. No sudo anywhere.
#
# Usage:
#   DEPLOY_HOST=ubuntu@your-server ./deploy.sh
#   DEPLOY_HOST=seoul-deploy DEPLOY_PATH=.ai-space/apps/dot-lib SERVICE=dot-lib ./deploy.sh
#
# Requirements on the server: node 22+ on /usr/bin/node and a user systemd
# session (deploy.sh enables linger so the unit survives logout).
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
# The unit is re-installed on every deploy, so editing deploy/dot-lib.service
# is enough; no manual step.
set -euo pipefail

DEPLOY_HOST="${DEPLOY_HOST:?set DEPLOY_HOST, e.g. DEPLOY_HOST=ubuntu@1.2.3.4 ./deploy.sh}"
DEPLOY_PATH="${DEPLOY_PATH:-.ai-space/apps/dot-lib}"   # relative paths are under the remote home
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

echo "==> Installing user systemd unit ${SERVICE}.service"
remote_dir=$(ssh "$DEPLOY_HOST" "cd '$DEPLOY_PATH' && pwd")
sed -e "s|@DIR@|${remote_dir}|g" deploy/dot-lib.service |
  ssh "$DEPLOY_HOST" "mkdir -p ~/.config/systemd/user && cat > ~/.config/systemd/user/${SERVICE}.service"
ssh "$DEPLOY_HOST" "loginctl enable-linger \$(whoami) 2>/dev/null || true; systemctl --user daemon-reload && systemctl --user enable '${SERVICE}'"

echo "==> Restarting ${SERVICE}"
ssh "$DEPLOY_HOST" "systemctl --user restart '${SERVICE}'"
sleep 4

echo "==> Health check"
port=$(ssh "$DEPLOY_HOST" "grep -E '^PORT=' '$DEPLOY_PATH/.env' | tail -1 | cut -d= -f2" || true)
port="${port:-8787}"
code=$(ssh "$DEPLOY_HOST" "curl -s -o /dev/null -w '%{http_code}' 'http://127.0.0.1:${port}/healthz'" || true)
if [ "$code" = "200" ]; then
  echo "    OK — /healthz returned 200 on port ${port}"
else
  echo "    FAILED — /healthz returned '${code}'"
  ssh "$DEPLOY_HOST" "journalctl --user -u '${SERVICE}' -n 20 --no-pager"
  exit 1
fi

echo "==> Done. Logs: ssh $DEPLOY_HOST 'journalctl --user -u ${SERVICE} -f'"
