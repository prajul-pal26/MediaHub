# MediaHub — Local Development

## Quick Start

```bash
git clone git@github.com:DeepVidyaAI/MediaHub.git
cd MediaHub
bash scripts/start.sh
```

Open **http://localhost:3000** and login with **admin@mediahub.local / admin123**

## What the start script does

1. Checks Docker + Node.js are installed
2. Creates `.env.local` if missing
3. Installs npm dependencies
4. Starts Docker (database, auth, redis, email)
5. Runs database schema + migrations (first time only)
6. Creates admin account (first time only)
7. Starts frontend + worker

## URLs

| Service | URL |
|---------|-----|
| **App** | http://localhost:3000 |
| **Supabase Studio** | http://localhost:54323 |
| **Email Testing** | http://localhost:54324 |

## Daily Usage

```bash
# Start everything
bash scripts/start.sh

# Stop (Ctrl+C stops frontend, then stop Docker)
docker compose down

# View worker logs
docker compose logs -f worker
```

## Useful Commands

```bash
# Reset database (destroys all data)
docker compose down -v
bash scripts/start.sh

# Restart just the worker
# (Ctrl+C the running process, then)
npm run dev:all
```

## Prerequisites

- **Docker** — https://docs.docker.com/get-docker/
- **Node.js 20+** — https://nodejs.org/
- **Git** — https://git-scm.com/
