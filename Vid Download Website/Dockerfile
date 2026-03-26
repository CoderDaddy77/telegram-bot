# Use an official Node.js runtime as the base image
FROM node:20-bookworm-slim

# Install Python 3, pip, and FFmpeg (with libx265 support for HEVC)
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# Install yt-dlp via pip
RUN pip3 install --break-system-packages yt-dlp

# Set the working directory in the container
WORKDIR /usr/src/app

# Copy the package.json files and install dependencies
COPY package*.json ./
RUN npm install --production

# Copy the rest of the application files
COPY . .

# Create directories for downloads and uploads
RUN mkdir -p downloads uploads

# Use system ffmpeg (not ffmpeg-static) — system ffmpeg has libx265 support
ENV FFMPEG_PATH=/usr/bin/ffmpeg

# Expose the port (Render sets PORT env var)
EXPOSE 3000

# Start the application
CMD ["npm", "start"]
