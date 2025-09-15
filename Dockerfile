# Production Dockerfile for FileScopeMCP
FROM node:22-slim

# Install system dependencies
RUN apt-get update && \
    apt-get install -y \
        python3 \
        make \
        g++ \
        curl \
        git \
    && rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /app

# Create non-root user for security
RUN groupadd -r filescope && useradd -r -g filescope filescope

# Copy package files and install dependencies
COPY package*.json ./
RUN npm ci --only=production && npm cache clean --force

# Copy source code and build
COPY . .
RUN npm run build

# Change ownership to non-root user
RUN chown -R filescope:filescope /app

# Switch to non-root user
USER filescope

# Set up runtime environment
ENV NODE_ENV=production
ENV PORT=3000
ENV HOST=0.0.0.0
ENV LOG_LEVEL=info

# Create data directory for file trees and configurations
RUN mkdir -p /app/data

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
    CMD curl -f http://localhost:${PORT}/health || exit 1

# Expose port
EXPOSE 3000

# Default command (HTTP server)
CMD ["node", "dist/start-http.js"]
