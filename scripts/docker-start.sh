#!/bin/bash
# ============================================
# MediaHub — Daily Startup
# ============================================
# Run this each day to start all services.
# Usage: bash scripts/docker-start.sh
#
# First time? Run: bash scripts/docker-setup.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_DIR"

# Check prerequisites
if [ ! -f ".env.local" ]; then
  echo "ERROR: .env.local not found."
  echo "Run first-time setup: bash scripts/docker-setup.sh"
  exit 1
fi

if [ ! -f "localhost+1.pem" ]; then
  echo "ERROR: SSL certificates not found."
  echo "Run first-time setup: bash scripts/docker-setup.sh"
  exit 1
fi

echo ""
echo "Starting MediaHub..."
echo ""

docker compose up -d

echo ""
echo "Waiting for services..."
sleep 5

# Quick health check
echo -n "  Database: "
docker compose exec -T db pg_isready -U supabase_admin -d supabase > /dev/null 2>&1 && echo "OK" || echo "starting..."

echo -n "  Redis:    "
docker compose exec -T redis redis-cli ping 2>/dev/null | grep -q PONG && echo "OK" || echo "starting..."

echo -n "  App:      "
curl -s -o /dev/null -w "%{http_code}" http://localhost:3000 2>/dev/null | grep -q "200\|307" && echo "OK" || echo "starting..."

echo ""
echo "MediaHub is running!"
echo ""
echo "  App:       https://localhost:3443"
echo "  Studio:    http://localhost:54323"
echo "  Inbucket:  http://localhost:54324"
echo ""
echo "  View logs: docker compose logs -f app worker"
echo "  Stop:      docker compose down"
echo ""
