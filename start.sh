#!/bin/bash
# ==========================================
#  MediaHub — One-Command Start (Linux/Mac)
# ==========================================
#  Usage: bash start.sh           (pull + rebuild everything)
#         bash start.sh --reset   (wipe everything, fresh start)
#  Requirements: Docker + Git
#
#  Always rebuilds ALL containers on every run so that any change
#  (code, schema, migrations, config) is picked up automatically.

set -e
cd "$(dirname "$0")"

echo ""
echo "=========================================="
echo "  MediaHub — Starting"
echo "=========================================="
echo ""

# ─── Check Docker ───
if ! command -v docker &> /dev/null; then
  echo "ERROR: Docker is not installed."
  echo "Install from: https://docs.docker.com/get-docker/"
  exit 1
fi

if ! docker info &> /dev/null 2>&1; then
  echo "ERROR: Docker is not running. Start Docker Desktop and try again."
  exit 1
fi

echo "[1/4] Docker OK"

# ─── Handle --reset flag ───
if [ "$1" = "--reset" ]; then
  echo ""
  echo "[2/4] Resetting — removing all containers and data..."
  docker compose down -v 2>/dev/null || true
  docker builder prune -f 2>/dev/null || true
  echo "  Clean slate ready."
else
  echo ""
  echo "[2/4] Stopping existing containers..."
  docker compose down 2>/dev/null || true
fi

# ─── Pull latest code ───
echo ""
echo "[3/4] Checking for code updates..."

if command -v git &> /dev/null && [ -d .git ]; then
  BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "main")
  git fetch origin "$BRANCH" 2>/dev/null || true

  LOCAL=$(git rev-parse HEAD 2>/dev/null)
  REMOTE=$(git rev-parse "origin/$BRANCH" 2>/dev/null || echo "$LOCAL")

  if [ "$LOCAL" != "$REMOTE" ]; then
    if git diff --quiet 2>/dev/null && git diff --cached --quiet 2>/dev/null; then
      echo "  Pulling latest code..."
      git pull origin "$BRANCH"
      echo "  Updated."
    else
      echo "  Updates available, but you have local changes — skipping pull."
    fi
  else
    echo "  Already up to date."
  fi
else
  echo "  No git — skipping update check."
fi

# ─── Build and start ALL services ───
echo ""
echo "[4/4] Building and starting all services..."
echo ""

# Build sequentially — worker first (small), then app (heavy) to avoid OOM
DOCKER_BUILDKIT=1 docker compose build worker 2>&1
DOCKER_BUILDKIT=1 docker compose build app 2>&1
docker compose up -d

echo ""
echo "=========================================="
echo "  MediaHub is running!"
echo "=========================================="
echo ""
echo "  App (HTTPS): https://localhost:3443"
echo "  App (HTTP):  http://localhost:3000"
echo "  Studio:      http://localhost:54323"
echo "  Email:       http://localhost:54324"
echo ""
echo "  First-time login: admin@mediahub.local / admin123"
echo ""
echo "  View logs:   docker compose logs -f app worker"
echo "  Stop:        docker compose down"
echo "  Full reset:  bash start.sh --reset"
echo ""
