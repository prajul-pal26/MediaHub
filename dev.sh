#!/bin/bash
# ==========================================
#  MediaHub — Dev Mode (HMR, no rebuilds)
# ==========================================
#  Usage: bash dev.sh                 (start dev stack with hot reload)
#         bash dev.sh --build         (force-rebuild the dev image, e.g. after
#                                      changing package.json / installing deps)
#         bash dev.sh --with-worker   (also start the BullMQ worker)
#
#  The worker is profile-gated ("background") on purpose, so a plain `dev.sh`
#  never resumes publishing by accident. But queued work — Editor renders,
#  categorization, analytics — only runs while it is up, so pass --with-worker
#  when you need it. Either flag may be given in any order.
#
#  Source is bind-mounted into the containers, so edits under src/ hot-reload:
#    - app    → next dev (Fast Refresh, frontend + backend)
#    - worker → tsx watch (restarts worker.ts on change)
#  You do NOT need to rebuild after code changes — just save the file.
#  Only re-run with --build when dependencies (package.json) change.

set -e
cd "$(dirname "$0")"
source "./scripts/docker-build-preflight.sh"

COMPOSE="docker compose -f docker-compose.yml -f docker-compose.dev.yml"

DO_BUILD=0
WITH_WORKER=0
for arg in "$@"; do
  case "$arg" in
    --build) DO_BUILD=1 ;;
    --with-worker) WITH_WORKER=1; COMPOSE="$COMPOSE --profile background" ;;
    *) echo "Unknown option: $arg (expected --build and/or --with-worker)"; exit 1 ;;
  esac
done

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
if [ "$DO_BUILD" = "1" ]; then
  echo "[build] Rebuilding dev image (dependencies changed)..."
  ensure_docker_build_space
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
if [ "$WITH_WORKER" = "1" ]; then
  echo "  Worker:          running (queued renders/jobs will be processed)"
else
  echo "  Worker:          NOT started — queued renders stay queued."
  echo "                   Start it with: bash dev.sh --with-worker"
fi
echo ""
