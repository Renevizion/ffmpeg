# syntax=docker/dockerfile:1
FROM node:20-slim

# Install system dependencies: ffmpeg, Python + pip (for yt-dlp), curl (healthcheck)
RUN apt-get update && apt-get install -y --no-install-recommends \
        ffmpeg \
        python3 \
        python3-pip \
        curl \
        ca-certificates \
    && pip3 install --no-cache-dir --break-system-packages "yt-dlp[default,curl-cffi]" \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy only what the server needs (no node_modules — zero npm deps)
COPY package.json ./
COPY server.js    ./

# Railway injects PORT at runtime; default to 3000 during local dev
ENV PORT=3000

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD curl -f http://localhost:3000/healthz || exit 1

CMD ["node", "server.js"]
