#!/usr/bin/env bash
# Deploy Bot Arena to botbattle.asenmitrev.uk (asenmitrev@100.90.63.53:~/arena, served via Cloudflare Tunnel).
#
# A deploy ends the season, so a season is never played under two rules versions:
#   1. check the code locally (typecheck, lint, tests)
#   2. stage it in ~/arena-next on the host: install + build there, while the live server keeps running
#   3. end the live season with hold: the playoff runs on the old code, the season is archived, and the new
#      season waits, closed to changes
#   4. only once the playoff has a champion: stop the server, copy the staged code over, install, build, start
# If the playoff fails or has no champion, the deploy stops and the old server goes on running.
#
# Needs the admin password in ARENA_ADMIN_PASSWORD (asks if unset). SKIP_CHECKS=1 skips step 1.
set -euo pipefail
HOST=asenmitrev@100.90.63.53
API=http://127.0.0.1:8787
POLL_SECONDS=10
MAX_WAIT_SECONDS=$((4 * 3600))
REMOTE_ENV='export PATH=$HOME/.nvm/versions/node/v20.19.5/bin:$PATH; set -euo pipefail'
PNPM='npx -y pnpm@10.28.1'
cd "$(dirname "$0")"

log() { printf '\n==> %s\n' "$*"; }
remote() { ssh "$HOST" "$REMOTE_ENV; $1"; }
# JSON field of a GET on the live API ("" when absent or null).
api_field() { remote "curl -fsS $API$1" | python3 -c 'import json,sys
v=json.load(sys.stdin)
for k in sys.argv[1].split("."):
    v = v[int(k)] if isinstance(v, list) else (v or {}).get(k)
print("" if v is None else json.dumps(v) if isinstance(v, (dict, list, bool)) else v)' "$2"; }

if [[ -z "${ARENA_ADMIN_PASSWORD:-}" ]]; then
  read -rsp "Admin password: " ARENA_ADMIN_PASSWORD
  echo
fi

if [[ "${SKIP_CHECKS:-}" != 1 ]]; then
  log "checking the code"
  pnpm -s typecheck
  pnpm -s lint
  pnpm -s test
fi

log "staging the new code in ~/arena-next"
RSYNC_EXCLUDES=(--exclude node_modules --exclude data --exclude 'data-backup-*' --exclude replays --exclude viewer/dist
  --exclude .nwave --exclude .git --exclude botbattle --exclude .DS_Store --exclude '.env*')
rsync -az --delete "${RSYNC_EXCLUDES[@]}" ./ "$HOST:arena-next/"
remote "cd ~/arena-next && $PNPM install --frozen-lockfile && (cd viewer && npx vite build)"

log "ending the live season (the playoff runs on the current code)"
PREV_SEASON=$(api_field /api/seasons -1.id 2>/dev/null || true)
RESPONSE=$(printf '%s' "$ARENA_ADMIN_PASSWORD" | ssh "$HOST" "python3 -c 'import json,sys; print(json.dumps({\"password\": sys.stdin.read(), \"hold\": True}))' \
  | curl -sS -w '\n%{http_code}' -X POST -H 'content-type: application/json' --data-binary @- $API/api/admin/end-season")
STATUS=${RESPONSE##*$'\n'}
if [[ "$STATUS" != 202 ]]; then
  echo "end-season answered $STATUS: ${RESPONSE%$'\n'*}" >&2
  exit 1
fi
if [[ "${RESPONSE%$'\n'*}" != *'"hold":true'* ]]; then
  echo "warning: the live server doesn't know 'hold' (older code), so the new season starts at once;" >&2
  echo "         the server is stopped as soon as the playoff ends, but a game or two may slip in." >&2
fi

waited=0
# Keep waiting while the playoff runs (or the API doesn't answer for a moment).
while state=$(api_field /api/health playoff 2>/dev/null || echo unreachable) && [[ "$state" == true || "$state" == unreachable ]]; do
  if ((waited >= MAX_WAIT_SECONDS)); then
    echo "the playoff is still running after $((waited / 60)) min; giving up (the old server keeps running)" >&2
    exit 1
  fi
  sleep "$POLL_SECONDS"
  waited=$((waited + POLL_SECONDS))
  printf '.'
done
echo

PLAYOFF_STATUS=$(api_field /api/playoff status)
CHAMPION=$(api_field /api/playoff champion.name)
SEASON=$(api_field /api/playoff seasonId)
if [[ "$PLAYOFF_STATUS" != done || -z "$CHAMPION" || -z "$SEASON" || "$SEASON" == "$PREV_SEASON" ]]; then
  echo "no champion (playoff: ${PLAYOFF_STATUS:-none}, error: $(api_field /api/playoff error)); not deploying." >&2
  echo "The old server keeps running the old season." >&2
  exit 1
fi
log "season $SEASON archived; champion: $CHAMPION"

log "restarting with the new code"
remote "systemctl --user stop arena
  rsync -a --delete $(printf '%q ' "${RSYNC_EXCLUDES[@]}") ~/arena-next/ ~/arena/
  cd ~/arena && $PNPM install --frozen-lockfile && (cd viewer && npx vite build)
  systemctl --user start arena && sleep 3 && systemctl --user is-active arena"
log "deployed; the new season has started"
