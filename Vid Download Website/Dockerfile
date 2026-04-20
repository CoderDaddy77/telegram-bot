# Vera Media Tools — Dockerfile for Render
# Node.js + LibreOffice for server-side file conversions

FROM node:20-slim

# Install LibreOffice + ffmpeg + yt-dlp
RUN apt-get update && apt-get install -y \
    libreoffice \
    libreoffice-writer \
    libreoffice-impress \
    libreoffice-calc \
    fonts-liberation \
    fonts-dejavu \
    ffmpeg \
    python3 \
    python3-pip \
    --no-install-recommends \
    && pip3 install --break-system-packages yt-dlp \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files and install Node deps
COPY package*.json ./
RUN npm install --omit=dev

# Copy server and public files
COPY server.js ./
COPY public/ ./public/

# LibreOffice user profile (avoids permission issues)
ENV HOME=/tmp

EXPOSE 3000

CMD ["node", "server.js"]
