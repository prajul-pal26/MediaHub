# MediaHub

Social media management platform for agencies and brands. Publish to Instagram, YouTube, and LinkedIn from one place.

---

## Run Locally

You need **Node.js 20+** and **Docker** installed on your machine.

```bash
# 1. Clone the repo
git clone <repo-url>
cd media_publisher

# 2. Install dependencies
npm install

# 3. Create your environment file
cp .env.development.example .env.local

# 4. Start the database and Redis
docker compose up -d
#    Wait 15 seconds for all services to start

# 5. Set up the database (creates all tables, indexes, policies)
bash scripts/setup-db.sh

# 6. Start the app (open two terminals)

# Terminal 1 — App server
npm run dev:https

# Terminal 2 — Background worker
npm run worker:dev

# 7. Open https://localhost:3443 in your browser
#    Click "Advanced" → "Proceed to localhost" on the certificate warning
#    Login with: pranjul@deepvidya.ai / 123456
```

That's it. The app is running.

---

## Run in Production

You need a **Supabase** project (hosted or self-hosted), a **Redis** instance, and a **Node.js** server.

```bash
# 1. Create your production environment file
cp .env.production.example .env.production

# 2. Fill in ALL the values in .env.production:
#    - NEXT_PUBLIC_SUPABASE_URL     → your Supabase project URL
#    - NEXT_PUBLIC_SUPABASE_ANON_KEY → your Supabase anon key
#    - SUPABASE_SERVICE_ROLE_KEY    → your Supabase service role key
#    - REDIS_URL                    → your Redis connection string
#    - TOKEN_ENCRYPTION_KEY         → run: openssl rand -hex 32
#    - NEXT_PUBLIC_APP_URL          → your domain (e.g. https://app.yourdomain.com)
#    - CRON_SECRET                  → run: openssl rand -hex 16

# 3. Run the database migrations
#    Apply all files in supabase/migrations/ to your Supabase project (in order)

# 4. Build the app
npm run build

# 5. Start the app (two processes)

# Process 1 — App server
npm start

# Process 2 — Background worker
npx tsx worker.ts

# 6. Set up a daily cron job to refresh tokens
#    POST https://app.yourdomain.com/api/cron/token-refresh
#    Header: Authorization: Bearer YOUR_CRON_SECRET
```

### After deployment

Go to each platform's developer console and set the redirect URIs to your production domain:

```
Instagram:    https://app.yourdomain.com/api/callback/instagram
YouTube:      https://app.yourdomain.com/api/callback/youtube
LinkedIn:     https://app.yourdomain.com/api/callback/linkedin
Google Drive:  https://app.yourdomain.com/api/callback/google-drive
```

---

## Database Changes (Important)

There are two database files. They serve different purposes:

| File | When to use | What it does |
|------|------------|-------------|
| `src/server/db/schema.sql` | **Fresh setup only** (no data) | Creates everything from scratch |
| `supabase/migrations/0000X_*.sql` | **Existing database** (has data) | Applies only the incremental change |

**NEVER run `schema.sql` on a production database that has data.** It can fail or destroy existing data.

### How to make database changes

```bash
# 1. Create a new migration file (use the next number)
touch supabase/migrations/00004_describe_your_change.sql

# 2. Write safe ALTER statements in it
#    Always use IF NOT EXISTS / IF EXISTS:
#
#    ALTER TABLE brands ADD COLUMN IF NOT EXISTS website TEXT;
#    CREATE INDEX IF NOT EXISTS idx_brands_website ON brands(website);

# 3. Test locally
docker exec -i media_publisher-db-1 env PGPASSWORD=postgres \
  psql -U supabase_admin -d supabase < supabase/migrations/00004_describe_your_change.sql

# 4. Also update schema.sql to match (so fresh setups get the correct schema)

# 5. Push to GitHub
git add supabase/migrations/00004_describe_your_change.sql src/server/db/schema.sql
git commit -m "describe your change"
git push

# 6. Apply to production
#    Hosted Supabase: SQL Editor → paste and run the migration file
#    Self-hosted: run the migration file against your production DB
```

Think of it this way:
- **`schema.sql`** = blueprint for building a new house
- **`migrations/`** = renovation instructions for an existing house

You never rebuild the whole house just to add a window.

---

## Full Documentation

See [working_pipeline.md](working_pipeline.md) for the complete system docs — database schema, API reference, RBAC, publish flows, LLM system, and everything else.
