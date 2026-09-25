#!/bin/bash
# ==========================================
#  MediaHub — Quick Restart (code changes only)
# ==========================================
#  Usage: bash restart.sh
#  Only rebuilds app + worker. Infrastructure stays running.

set -e
cd "$(dirname "$0")"

# Check if infrastructure is running
if ! docker compose ps 2>/dev/null | grep -q "mediahub-database.*running"; then
  echo "Infrastructure not running. Use 'bash start.sh' for first-time setup."
  exit 1
fi

echo ""
echo "Rebuilding app + worker (infrastructure stays running)..."
echo ""

docker compose up -d --build app worker caddy

echo ""
echo "Done! App: https://localhost:3443"
echo ""
