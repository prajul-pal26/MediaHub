#!/bin/bash
# ==========================================
#  MediaHub — Quick Restart (code changes only)
# ==========================================
#  Usage: bash restart.sh
#  Only rebuilds app + worker. Infrastructure stays running.

set -e
cd "$(dirname "$0")"
source "./scripts/docker-build-preflight.sh"

# Check if infrastructure is running
if ! docker compose ps 2>/dev/null | grep -qE "mediahub-database.*(running|Up)"; then
  echo "Infrastructure not running. Use 'bash start.sh' for first-time setup."
  exit 1
fi

echo ""
echo "Rebuilding app + worker (infrastructure stays running)..."
echo ""

ensure_docker_build_space
docker compose up -d --build app worker caddy

echo ""
echo "Done! App: https://localhost:3443"
echo ""
