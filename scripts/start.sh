#!/bin/bash
# ============================================
# MediaHub — One-Command Start
# ============================================
# Usage: bash scripts/start.sh
#
# First time: sets up everything automatically
# After that: just starts the services

set -e
cd "$(dirname "$0")/.."

echo ""
echo "=========================================="
echo "  MediaHub — Starting"
echo "=========================================="
echo ""

# ─── Check Docker ───
if ! command -v docker &> /dev/null; then
  echo "Docker is not installed. Please install it:"
  echo "  Mac:     https://docs.docker.com/desktop/install/mac-install/"
  echo "  Ubuntu:  https://docs.docker.com/engine/install/ubuntu/"
  echo "  Windows: https://docs.docker.com/desktop/install/windows-install/"
  exit 1
fi

if ! docker info &> /dev/null; then
  echo "Docker is not running. Please start Docker Desktop."
  exit 1
fi

# ─── Check Node.js ───
if ! command -v node &> /dev/null; then
  echo "Node.js is not installed. Please install Node.js 20+:"
  echo "  https://nodejs.org/"
  exit 1
fi

# ─── Create .env.local if missing ───
if [ ! -f .env.local ]; then
  echo "Creating .env.local..."
  ENCRYPTION_KEY=$(openssl rand -hex 32 2>/dev/null || node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
  cat > .env.local << EOF
NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0
SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU
REDIS_URL=redis://localhost:6379
TOKEN_ENCRYPTION_KEY=${ENCRYPTION_KEY}
NEXT_PUBLIC_APP_URL=https://localhost:3443
CRON_SECRET=dev-cron-secret
EOF
  echo "  Created .env.local"
fi

# ─── Install npm dependencies ───
if [ ! -d node_modules ]; then
  echo "Installing dependencies..."
  npm install
fi

# ─── Generate SSL certs (required for Instagram/Facebook OAuth) ───
if [ ! -f localhost+1.pem ] || [ ! -f localhost+1-key.pem ]; then
  echo "Generating SSL certificates..."
  openssl req -x509 -newkey rsa:2048 \
    -keyout localhost+1-key.pem -out localhost+1.pem \
    -days 365 -nodes -subj "/CN=localhost" \
    -addext "subjectAltName=DNS:localhost,IP:127.0.0.1" 2>/dev/null
  echo "  SSL certs generated"
fi

# ─── Start Docker services ───
echo "Starting Docker services..."
docker compose up -d

# ─── Wait for database ───
echo -n "Waiting for database..."
for i in $(seq 1 30); do
  if docker exec mediahub-database pg_isready -U supabase_admin -d supabase > /dev/null 2>&1; then
    echo " ready"
    break
  fi
  echo -n "."
  sleep 2
done

# ─── Wait for auth ───
echo -n "Waiting for auth..."
for i in $(seq 1 30); do
  TABLES=$(docker exec mediahub-database env PGPASSWORD=postgres psql -U supabase_admin -d supabase -t -c "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'auth' AND table_name = 'users';" 2>/dev/null | tr -d ' ')
  if [ "$TABLES" = "1" ]; then
    echo " ready"
    break
  fi
  echo -n "."
  sleep 2
done

# ─── First-time setup: schema + migrations + admin ───
USERS_TABLE=$(docker exec mediahub-database env PGPASSWORD=postgres psql -U supabase_admin -d supabase -t -c "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'users';" 2>/dev/null | tr -d ' ')

if [ "$USERS_TABLE" != "1" ]; then
  echo "First-time setup: applying schema..."

  # Auth helper functions
  docker exec mediahub-database env PGPASSWORD=postgres psql -U supabase_admin -d supabase -c "
    CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS \$\$SELECT COALESCE(current_setting('request.jwt.claim.sub',true),(current_setting('request.jwt.claims',true)::jsonb->>'sub'))::uuid\$\$;
    CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS \$\$SELECT COALESCE(current_setting('request.jwt.claim.role',true),(current_setting('request.jwt.claims',true)::jsonb->>'role'))::text\$\$;
    CREATE OR REPLACE FUNCTION auth.email() RETURNS text LANGUAGE sql STABLE AS \$\$SELECT COALESCE(current_setting('request.jwt.claim.email',true),(current_setting('request.jwt.claims',true)::jsonb->>'email'))::text\$\$;
    CREATE OR REPLACE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS \$\$SELECT coalesce(current_setting('request.jwt.claims',true),'{}')::jsonb\$\$;
  " > /dev/null 2>&1

  # Schema
  docker exec -i mediahub-database env PGPASSWORD=postgres psql -U supabase_admin -d supabase < src/server/db/schema.sql > /dev/null 2>&1

  # Migrations
  for f in supabase/migrations/*.sql; do
    [ -f "$f" ] && docker exec -i mediahub-database env PGPASSWORD=postgres psql -U supabase_admin -d supabase < "$f" > /dev/null 2>&1
  done

  # Restart REST to pick up new schema
  docker restart mediahub-rest > /dev/null 2>&1
  sleep 3

  # Create admin user
  echo "Creating admin user..."
  sleep 5  # Wait for Kong to resolve auth after restart
  ADMIN_EMAIL="${ADMIN_EMAIL:-admin@mediahub.local}"
  ADMIN_PASSWORD="${ADMIN_PASSWORD:-admin123}"

  curl -s -X POST "http://127.0.0.1:54321/auth/v1/admin/users" \
    -H "apikey: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU" \
    -H "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU" \
    -H "Content-Type: application/json" \
    -d "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\",\"email_confirm\":true,\"user_metadata\":{\"name\":\"Super Admin\"}}" > /dev/null 2>&1

  echo "  Admin: $ADMIN_EMAIL / $ADMIN_PASSWORD"
  echo ""
fi

# ─── Start app + worker ───
echo "Starting frontend + worker..."
echo ""
echo "=========================================="
echo "  MediaHub is running!"
echo "=========================================="
echo ""
echo "  App:     https://localhost:3443 (or http://localhost:3000)"
echo "  Studio:  http://localhost:54323"
echo "  Email:   http://localhost:54324"
echo ""
echo "  Login:   ${ADMIN_EMAIL:-admin@mediahub.local} / ${ADMIN_PASSWORD:-admin123}"
echo ""
echo "  Press Ctrl+C to stop"
echo ""

npm run dev:all
