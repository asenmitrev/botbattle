#!/usr/bin/env bash
# Redeploy Bot Arena to botbattle.asenmitrev.uk (asenmitrev@100.90.63.53:~/arena, served via Cloudflare Tunnel).
# Ladder data in ~/arena/data is kept.
set -euo pipefail
HOST=asenmitrev@100.90.63.53
cd "$(dirname "$0")"
rsync -az --delete --exclude node_modules --exclude 'data' --exclude 'data-backup-*' --exclude replays \
  --exclude viewer/dist --exclude .nwave --exclude .git --exclude .gitignore --exclude botbattle --exclude .DS_Store --exclude deploy.sh ./ "$HOST:arena/"
ssh "$HOST" 'export PATH=$HOME/.nvm/versions/node/v20.19.5/bin:$PATH; set -e; cd ~/arena
  npx -y pnpm@10.28.1 install --frozen-lockfile
  (cd viewer && npx vite build)
  systemctl --user restart arena && sleep 3 && systemctl --user is-active arena'
