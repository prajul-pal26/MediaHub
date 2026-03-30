#!/bin/bash
# Set up the MediaHub database from scratch.
# Run this ONCE after starting Docker containers.
# Usage: bash scripts/setup-db.sh

set -e

CONTAINER="${DB_CONTAINER:-media_publisher-db-1}"
DB_USER="supabase_admin"
DB_PASS="postgres"
DB_NAME="supabase"

echo ""
echo "=== MediaHub Database Setup ==="
echo ""

# 1. Check Docker container is running
echo "1. Checking database container..."
if ! docker ps --format '{{.Names}}' | grep -q "$CONTAINER"; then
  echo "   ERROR: Container '$CONTAINER' is not running."
  echo "   Run 'docker compose up -d' first and wait 10-15 seconds."
  exit 1
fi
echo "   OK"

# 2. Check database is reachable
echo "2. Checking database connection..."
docker exec "$CONTAINER" env PGPASSWORD="$DB_PASS" psql -U "$DB_USER" -d "$DB_NAME" -c "SELECT 1" >/dev/null 2>&1 \
  || { echo "   ERROR: Cannot connect to database. Wait a few seconds and retry."; exit 1; }
echo "   OK"

# 3. Check auth schema exists (GoTrue must be running)
echo "3. Checking Supabase Auth is ready..."
docker exec "$CONTAINER" env PGPASSWORD="$DB_PASS" psql -U "$DB_USER" -d "$DB_NAME" -c "SELECT 1 FROM auth.users LIMIT 0" >/dev/null 2>&1 \
  || { echo "   ERROR: auth.users table not found. Wait for GoTrue to start."; exit 1; }
echo "   OK"

# 4. Apply main schema
echo "4. Applying main schema (tables, RLS, indexes, triggers)..."
docker exec -i "$CONTAINER" env PGPASSWORD="$DB_PASS" psql -U "$DB_USER" -d "$DB_NAME" < src/server/db/schema.sql 2>&1 | tail -5
echo "   OK"

# 5. Apply migrations
echo "5. Applying migrations..."
for migration in supabase/migrations/*.sql; do
  if [ -f "$migration" ]; then
    echo "   Applying $(basename $migration)..."
    docker exec -i "$CONTAINER" env PGPASSWORD="$DB_PASS" psql -U "$DB_USER" -d "$DB_NAME" < "$migration" 2>&1 | grep -i "error" || true
  fi
done
echo "   OK"

# 6. Reload PostgREST schema cache (so it knows about new tables)
echo "6. Reloading PostgREST schema cache..."
docker restart media_publisher-rest-1 >/dev/null 2>&1 || true
echo "   OK"

# 7. Create default super admin
echo "7. Creating default super admin..."
bash scripts/create-superadmin.sh
echo "   OK"

echo ""
echo "=== Database setup complete ==="
echo ""
echo "You can now:"
echo "  1. Start the app:    npm run dev:https"
echo "  2. Start the worker: npm run worker:dev"
echo "  3. Open the app:     https://localhost:3443"
echo "  4. Login with:       pranjul@deepvidya.ai / 123456"
echo ""
