# MediaHub — Development Dockerfile
# Used for both the app (Next.js) and worker (BullMQ) services
FROM node:20-alpine

# Install FFmpeg (for video processing in worker) and mkcert dependencies
RUN apk add --no-cache ffmpeg bash curl openssl

WORKDIR /app

# Install dependencies first (for better layer caching)
COPY package.json package-lock.json* ./
RUN npm install

# Copy the rest of the codebase
COPY . .

# Default command (overridden per service in docker-compose)
CMD ["npm", "run", "dev"]
