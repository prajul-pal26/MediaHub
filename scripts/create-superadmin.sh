#!/bin/bash
# Create the default super admin user.
# Run this ONCE after setting up the database.
#
# Usage:
#   Local:      bash scripts/create-superadmin.sh
#   Production: bash scripts/create-superadmin.sh
#
# Reads NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY from .env.local or environment.

set -e

# Load env vars from .env.local if it exists
if [ -f .env.local ]; then
  export $(grep -v '^#' .env.local | grep -v '^$' | xargs)
fi

SUPABASE_URL="${NEXT_PUBLIC_SUPABASE_URL}"
SERVICE_KEY="${SUPABASE_SERVICE_ROLE_KEY}"
ADMIN_EMAIL="${1:-pranjul@deepvidya.ai}"
ADMIN_PASSWORD="${2:-123456}"

if [ -z "$SUPABASE_URL" ] || [ -z "$SERVICE_KEY" ]; then
  echo "ERROR: NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set."
  echo "Either set them in .env.local or as environment variables."
  exit 1
fi

echo ""
echo "=== Creating Super Admin ==="
echo "  URL:   $SUPABASE_URL"
echo "  Email: $ADMIN_EMAIL"
echo ""

# Create user via Supabase Auth Admin API
RESPONSE=$(curl -s -w "\n%{http_code}" -X POST \
  "${SUPABASE_URL}/auth/v1/admin/users" \
  -H "apikey: ${SERVICE_KEY}" \
  -H "Authorization: Bearer ${SERVICE_KEY}" \
  -H "Content-Type: application/json" \
  -d "{
    \"email\": \"${ADMIN_EMAIL}\",
    \"password\": \"${ADMIN_PASSWORD}\",
    \"email_confirm\": true,
    \"user_metadata\": { \"name\": \"Super Admin\" }
  }")

HTTP_CODE=$(echo "$RESPONSE" | tail -1)
BODY=$(echo "$RESPONSE" | sed '$d')

if [ "$HTTP_CODE" = "200" ] || [ "$HTTP_CODE" = "201" ]; then
  echo "  Super admin created successfully!"
  echo "  The handle_new_user() trigger automatically set role = super_admin"
  echo ""
  echo "  Login with:"
  echo "    Email:    $ADMIN_EMAIL"
  echo "    Password: $ADMIN_PASSWORD"
  echo ""
  echo "  IMPORTANT: Change this password after first login!"
elif echo "$BODY" | grep -qi "already been registered"; then
  echo "  User already exists — skipping."
else
  echo "  ERROR: Failed to create user (HTTP $HTTP_CODE)"
  echo "  $BODY"
  exit 1
fi
