#!/bin/bash
# ============================================
# MediaHub — Docker DB Initialization
# ============================================
# Runs as a one-shot init container inside Docker.
# Applies schema + migrations on first run, skips on subsequent runs.

set -e

echo ""
echo "=== MediaHub DB Init ==="
echo ""

# Install curl (needed for admin user creation via Auth API)
apk add --no-cache curl > /dev/null 2>&1

# ─── Wait for auth.users table (GoTrue must have run its migrations) ───
echo "Waiting for Supabase Auth..."
for i in $(seq 1 60); do
  if psql -c "SELECT 1 FROM auth.users LIMIT 0" > /dev/null 2>&1; then
    echo "  Auth ready."
    break
  fi
  if [ "$i" = "60" ]; then
    echo "  ERROR: Auth not ready after 2 minutes. Exiting."
    exit 1
  fi
  sleep 2
done

# ─── Check if schema already applied ───
USERS_EXISTS=$(psql -t -c "SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_name='users'" 2>/dev/null | tr -d ' ')

if [ "$USERS_EXISTS" = "1" ]; then
  echo "Schema already applied. Nothing to do."
  echo ""
  exit 0
fi

# ─── Apply main schema ───
echo "Applying schema..."
psql < /schema.sql > /dev/null 2>&1
echo "  Done."

# ─── Apply migrations ───
echo "Applying migrations..."
for f in /migrations/*.sql; do
  if [ -f "$f" ]; then
    echo "  $(basename "$f")"
    psql < "$f" > /dev/null 2>&1 || true
  fi
done
echo "  Done."

# ─── Tell PostgREST to reload schema cache ───
psql -c "NOTIFY pgrst, 'reload schema'" > /dev/null 2>&1

# ─── Create admin user via Supabase Auth API ───
echo "Creating admin user..."

# Wait for Kong (API gateway) to be reachable
for i in $(seq 1 30); do
  if curl -sf http://kong:8000/rest/v1/ -H "apikey: $ANON_KEY" > /dev/null 2>&1; then
    break
  fi
  sleep 2
done

sleep 3  # Extra buffer for auth service to register new tables

RESPONSE=$(curl -s -w "\n%{http_code}" -X POST \
  "http://kong:8000/auth/v1/admin/users" \
  -H "apikey: ${SERVICE_ROLE_KEY}" \
  -H "Authorization: Bearer ${SERVICE_ROLE_KEY}" \
  -H "Content-Type: application/json" \
  -d "{
    \"email\": \"${ADMIN_EMAIL}\",
    \"password\": \"${ADMIN_PASSWORD}\",
    \"email_confirm\": true,
    \"user_metadata\": { \"name\": \"Super Admin\" }
  }")

HTTP_CODE=$(echo "$RESPONSE" | tail -1)

if [ "$HTTP_CODE" = "200" ] || [ "$HTTP_CODE" = "201" ]; then
  echo "  Admin created: ${ADMIN_EMAIL} / ${ADMIN_PASSWORD}"
elif echo "$RESPONSE" | grep -qi "already been registered"; then
  echo "  Admin already exists — skipped."
else
  echo "  WARNING: Could not create admin (HTTP $HTTP_CODE). Create manually later."
fi

echo ""
echo "=== DB Init Complete ==="
echo ""
