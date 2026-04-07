# MediaHub — Local Development Setup

One-command setup for the full MediaHub platform.

## Prerequisites

- **Docker Desktop** (Mac) or **Docker Engine** (Ubuntu)
- **Git**

That's it. No Node.js, no Redis, no PostgreSQL needed on your machine.

## First-Time Setup

```bash
# 1. Clone the repo
git clone git@github.com:DeepVidyaAI/MediaHub.git
cd MediaHub

# 2. Run setup (takes ~3 minutes)
bash scripts/docker-setup.sh

# 3. Open the app
# https://localhost:3443
```

The setup script will:
- Generate SSL certificates (for Instagram/Meta OAuth)
- Create `.env.local` with all required variables
- Start all Docker services
- Set up the database (tables, RLS, migrations)
- Create a default super admin account

## Daily Usage

```bash
# Start everything
docker compose up

# Or run in background
docker compose up -d

# View logs (app + worker)
docker compose logs -f app worker

# Stop everything
docker compose down
```

## Login

| | |
|---|---|
| **URL** | https://localhost:3443 |
| **Email** | pranjul@deepvidya.ai |
| **Password** | 123456 |

Change the password after first login.

## Services

| Service | URL | Purpose |
|---------|-----|---------|
| **App** | https://localhost:3443 | MediaHub (HTTPS) |
| **App (direct)** | http://localhost:3000 | MediaHub (HTTP, no OAuth) |
| **Supabase Studio** | http://localhost:54323 | Database UI |
| **Inbucket** | http://localhost:54324 | Email testing |
| **Redis** | localhost:6379 | Job queue |

## Hot Reload

Code changes are automatically picked up:
- **Frontend** (Next.js) — edit any file in `src/`, browser refreshes
- **Worker** — edit `worker.ts`, worker auto-restarts

No need to rebuild Docker containers when editing code.

## Useful Commands

```bash
# Rebuild after package.json changes
docker compose up --build

# View worker logs only
docker compose logs -f worker

# Restart just the worker
docker compose restart worker

# Reset database (destructive!)
docker compose down -v
bash scripts/docker-setup.sh

# Open a database shell
docker compose exec db psql -U supabase_admin -d supabase
```

## Connecting Social Accounts

Platform credentials (Instagram, YouTube, LinkedIn, Facebook) are managed in:
**Settings → Platform Credentials**

OAuth redirect URIs are pre-configured for `https://localhost:3443`.

## Troubleshooting

### "This site can't provide a secure connection"
The SSL proxy might not be ready yet. Wait 10 seconds and refresh.

### "localhost refused to connect"
Run `docker compose ps` to check if all services are running.
If a service is unhealthy, check its logs: `docker compose logs <service-name>`

### Database not connecting
```bash
docker compose restart db
sleep 10
docker compose restart rest kong
```

### Need a fresh start
```bash
docker compose down -v   # removes all data
bash scripts/docker-setup.sh
```
