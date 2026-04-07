#!/bin/bash
# ============================================
# MediaHub — Docker Init Script
# ============================================
# Runs inside the 'init' container after all services are up.
# Handles: auth functions, schema, migrations, admin user.
# Safe to re-run — all operations are idempotent.

set -e

DB_HOST="${DB_HOST:-db}"
DB_PORT="${DB_PORT:-5432}"
DB_USER="${DB_USER:-supabase_admin}"
DB_PASS="${DB_PASS:-postgres}"
DB_NAME="${DB_NAME:-supabase}"
SUPABASE_URL="${SUPABASE_URL:-http://kong:8000}"
SERVICE_KEY="${SUPABASE_SERVICE_ROLE_KEY}"
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@mediahub.local}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-admin123}"

run_sql() {
  PGPASSWORD="$DB_PASS" psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -q "$@" 2>&1
}

echo ""
echo "=== MediaHub Init ==="
echo ""

# ─── 1. Wait for database ───
echo "1. Waiting for database..."
for i in $(seq 1 30); do
  if PGPASSWORD="$DB_PASS" pg_isready -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" > /dev/null 2>&1; then
    echo "   Database ready"
    break
  fi
  [ $i -eq 30 ] && { echo "   TIMEOUT: database not ready"; exit 1; }
  sleep 2
done

# ─── 2. Wait for GoTrue (auth) to finish its migrations ───
echo "2. Waiting for auth service..."
for i in $(seq 1 30); do
  AUTH_TABLES=$(run_sql -t -c "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'auth' AND table_name = 'users';" | tr -d ' ')
  if [ "$AUTH_TABLES" = "1" ]; then
    echo "   Auth ready (auth.users exists)"
    break
  fi
  [ $i -eq 30 ] && { echo "   TIMEOUT: auth.users not found"; exit 1; }
  sleep 3
done

# ─── 3. Create auth helper functions ───
echo "3. Creating auth helper functions..."
run_sql << 'SQL'
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT COALESCE(current_setting('request.jwt.claim.sub', true),(current_setting('request.jwt.claims', true)::jsonb ->> 'sub'))::uuid
$$;
CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$
  SELECT COALESCE(current_setting('request.jwt.claim.role', true),(current_setting('request.jwt.claims', true)::jsonb ->> 'role'))::text
$$;
CREATE OR REPLACE FUNCTION auth.email() RETURNS text LANGUAGE sql STABLE AS $$
  SELECT COALESCE(current_setting('request.jwt.claim.email', true),(current_setting('request.jwt.claims', true)::jsonb ->> 'email'))::text
$$;
CREATE OR REPLACE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT coalesce(current_setting('request.jwt.claims', true), '{}')::jsonb
$$;
SQL
echo "   Done"

# ─── 4. Apply main schema ───
echo "4. Applying schema..."
run_sql < /app/src/server/db/schema.sql | grep -c "ERROR" | xargs -I{} echo "   ({} already-exists warnings, OK)"

# ─── 5. Apply migrations ───
echo "5. Applying migrations..."
for f in /app/supabase/migrations/*.sql; do
  [ -f "$f" ] || continue
  echo "   $(basename $f)"
  run_sql < "$f" 2>&1 | grep "ERROR" | grep -v "already exists" || true
done
echo "   Done"

# ─── 6. Reload PostgREST ───
echo "6. Reloading API cache..."
curl -s -X POST "http://rest:3000" > /dev/null 2>&1 || true

# ─── 7. Wait for Kong to be reachable ───
echo "7. Waiting for API gateway..."
for i in $(seq 1 20); do
  if curl -s -o /dev/null -w "%{http_code}" "$SUPABASE_URL/rest/v1/" | grep -q "200\|401"; then
    echo "   API gateway ready"
    break
  fi
  sleep 2
done

# ─── 8. Create admin user (idempotent) ───
echo "8. Creating admin user ($ADMIN_EMAIL)..."
RESPONSE=$(curl -s -w "\n%{http_code}" -X POST "$SUPABASE_URL/auth/v1/admin/users" \
  -H "apikey: $SERVICE_KEY" \
  -H "Authorization: Bearer $SERVICE_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\",\"email_confirm\":true,\"user_metadata\":{\"name\":\"Super Admin\"}}")

HTTP_CODE=$(echo "$RESPONSE" | tail -1)
BODY=$(echo "$RESPONSE" | sed '$d')

if [ "$HTTP_CODE" = "200" ] || [ "$HTTP_CODE" = "201" ]; then
  echo "   Admin created: $ADMIN_EMAIL / $ADMIN_PASSWORD"
elif echo "$BODY" | grep -qi "already"; then
  echo "   Admin already exists"
else
  echo "   WARNING: Admin creation returned HTTP $HTTP_CODE"
  echo "   $BODY" | head -3
fi

echo ""
echo "=== Init complete ==="
echo ""
echo "  App:     http://localhost:3000"
echo "  HTTPS:   https://localhost:3443"
echo "  Studio:  http://localhost:54323"
echo "  Email:   http://localhost:54324"
echo ""
echo "  Login:   $ADMIN_EMAIL / $ADMIN_PASSWORD"
echo ""
