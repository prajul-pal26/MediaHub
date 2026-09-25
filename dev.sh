#!/bin/bash
# ==========================================
#  MediaHub — Dev Mode (HMR, no rebuilds)
# ==========================================
#  Usage: bash dev.sh            (start dev stack with hot reload)
#         bash dev.sh --build    (force-rebuild the dev image, e.g. after
#                                 changing package.json / installing deps)
#
#  Source is bind-mounted into the containers, so edits under src/ hot-reload:
#    - app    → next dev (Fast Refresh, frontend + backend)
#    - worker → tsx watch (restarts worker.ts on change)
#  You do NOT need to rebuild after code changes — just save the file.
#  Only re-run with --build when dependencies (package.json) change.

set -e
cd "$(dirname "$0")"

COMPOSE="docker compose -f docker-compose.yml -f docker-compose.dev.yml"

echo ""
echo "=========================================="
echo "  MediaHub — Dev Mode (HMR)"
echo "=========================================="
echo ""

if ! docker info &> /dev/null 2>&1; then
  echo "ERROR: Docker is not running. Start Docker Desktop and try again."
  exit 1
fi

# Build the dev image only when asked, or when it doesn't exist yet.
if [ "$1" = "--build" ]; then
  echo "[build] Rebuilding dev image (dependencies changed)..."
  DOCKER_BUILDKIT=1 $COMPOSE build app worker
fi

echo "[up] Starting dev stack..."
$COMPOSE up -d

echo ""
echo "=========================================="
echo "  Dev mode running — edit & save, no rebuild"
echo "=========================================="
echo ""
echo "  App (HTTPS): https://localhost:3443"
echo "  App (HTTP):  http://localhost:3000"
echo "  Studio:      http://localhost:54323"
echo ""
echo "  Logs:            $COMPOSE logs -f app worker"
echo "  Stop:            $COMPOSE down"
echo "  After deps change: bash dev.sh --build"
echo ""
