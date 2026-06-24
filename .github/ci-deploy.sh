#!/usr/bin/env bash
# Runs ON the VPS (piped in over SSH by .github/workflows/deploy.yml).
# Fast-forwards /opt/titb to origin/main and restarts the backend only when
# server code changed. Kept out of server/ on purpose so editing this script
# never trips the "backend changed → restart" check below.
set -euo pipefail

cd /opt/titb

before=$(git rev-parse HEAD)
git pull --ff-only origin main
after=$(git rev-parse HEAD)

if [ "$before" = "$after" ]; then
  echo "already up to date ($after) — nothing to do"
  exit 0
fi

# Restart only for backend/contract changes; frontend (index.html, docs) is served
# with no-cache, so a pull is enough and we avoid dropping live WebSocket sessions.
if git diff --name-only "$before" "$after" | grep -qE '^server/|^package(-lock)?\.json$'; then
  # Snapshot saved room/player data BEFORE the restart — the save format can convert
  # on boot (player/world decoupling), so keep recoverable backups outside the git tree.
  if [ -d server/data ]; then
    mkdir -p /opt/titb-backups
    archive="/opt/titb-backups/data-$(date +%Y%m%d-%H%M%S)-${after:0:7}.tgz"
    tar czf "$archive" -C server data && echo "backed up server/data → $archive"
    # keep only the 20 most recent snapshots
    ls -1t /opt/titb-backups/data-*.tgz 2>/dev/null | tail -n +21 | xargs -r rm -f
  fi
  echo "backend changed → restarting titb"
  systemctl restart titb
  echo "deployed $after (restarted)"
else
  echo "deployed $after (frontend only → no restart; no-cache serves it on next load)"
fi
