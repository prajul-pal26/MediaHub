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

RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nextjs

# Copy standalone server + static assets
COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

USER nextjs
EXPOSE 3000
ENV HOSTNAME=0.0.0.0
ENV PORT=3000
CMD ["node", "server.js"]

# ─── Worker (doesn't need Next.js build, just tsx + node_modules) ───
FROM node:20-alpine AS worker
RUN apk add --no-cache libc6-compat ffmpeg
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
CMD ["npx", "tsx", "worker.ts"]
