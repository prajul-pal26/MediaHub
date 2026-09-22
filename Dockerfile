# syntax=docker/dockerfile:1
# ============================================
# MediaHub — Multi-stage Dockerfile
# ============================================
# Targets:
#   app    — Production Next.js server (pre-compiled, fast)
#   worker — BullMQ background worker
#
# Optimizations:
#   - BuildKit cache mounts for npm (skip npm ci on code-only changes)
#   - BuildKit cache mount for .next/cache (incremental Next.js builds)
#   - Separate base images for app vs worker (worker doesn't need ffmpeg)
# ============================================

# ─── Base (shared) ───
FROM node:20-alpine AS base
RUN apk add --no-cache libc6-compat
WORKDIR /app

# ─── Dependencies (cached unless package.json changes) ───
FROM base AS deps
COPY package.json package-lock.json* ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci

# ─── Builder (Next.js production build) ───
FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# NEXT_PUBLIC_ vars are baked into the client bundle at build time.
# These must match what the BROWSER will use (localhost, not Docker internal).
ENV NEXT_PUBLIC_SUPABASE_URL=http://localhost:54321
ENV NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0
ENV NEXT_PUBLIC_APP_URL=https://localhost:3443
ENV NEXT_TELEMETRY_DISABLED=1
ENV NODE_OPTIONS=--max-old-space-size=1024

# Cache .next/cache between builds for faster incremental compilation
RUN --mount=type=cache,target=/app/.next/cache \
    npm run build

# ─── Production App ───
FROM node:20-alpine AS app
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

# Chromium for the Playwright-based Facebook page scraper (session rendering).
RUN apk add --no-cache \
    chromium xvfb nss freetype harfbuzz ca-certificates ttf-freefont font-noto-emoji
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    CHROMIUM_PATH=/usr/bin/chromium \
    FB_HEADFUL=1

RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nextjs

# Copy standalone server + static assets
COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
# Ensure the full playwright-core package is present (belt-and-suspenders vs tracing).
COPY --from=deps --chown=nextjs:nodejs /app/node_modules/playwright-core ./node_modules/playwright-core

USER nextjs
EXPOSE 3000
ENV HOSTNAME=0.0.0.0
ENV PORT=3000
CMD ["node", "server.js"]

# ─── Worker ───
# Facebook jobs may be dispatched from worker-owned flows. Keep its browser
# runtime aligned with the app image so those jobs never fail at launch time.
FROM node:20-alpine AS worker
RUN apk add --no-cache \
    libc6-compat ffmpeg chromium xvfb nss freetype harfbuzz ca-certificates ttf-freefont font-noto-emoji
WORKDIR /app
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    CHROMIUM_PATH=/usr/bin/chromium \
    FB_HEADFUL=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
CMD ["npx", "tsx", "worker.ts"]

# ─── Dev (HMR — no production build) ───
# Used by docker-compose.dev.yml. Source is bind-mounted at runtime, so code
# edits hot-reload with NO image rebuild. node_modules stays in the image
# (masked by an anonymous volume) so the empty host tree never clobbers it.
FROM base AS dev
ENV NODE_ENV=development
# ffmpeg (worker) + chromium (Facebook scraper) so the same image runs both.
RUN apk add --no-cache \
    ffmpeg chromium xvfb nss freetype harfbuzz ca-certificates ttf-freefont font-noto-emoji
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    CHROMIUM_PATH=/usr/bin/chromium \
    NEXT_TELEMETRY_DISABLED=1 \
    WATCHPACK_POLLING=true \
    FB_HEADFUL=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
EXPOSE 3000
CMD ["npm", "run", "dev"]
