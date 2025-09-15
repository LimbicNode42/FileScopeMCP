# FileScopeMCP Docker Deployment Guide

This guide covers deploying FileScopeMCP using Docker and Docker Compose for both development and production environments.

## Quick Start

### Prerequisites

- Docker Engine 20.10+
- Docker Compose 2.0+
- At least 512MB available RAM
- Your project/codebase directory to analyze

### 1. Environment Setup

Copy the environment template:
```bash
cp .env.example .env
```

Edit `.env` and set required variables:
```bash
# Required: Path to your codebase
WORKSPACE_PATH=/path/to/your/project

# Optional: Specific project within workspace
PROJECT_PATH=/path/to/specific/project

# HTTP server port (default: 3000)
PORT=3000
```

### 2. Production Deployment

```bash
# Build and start the service
npm run docker:up

# Or using docker-compose directly
docker-compose up -d
```

The service will be available at `http://localhost:3000`

### 3. Development Setup

```bash
# Start development environment with hot reload
npm run docker:up:dev

# Or using docker-compose directly
docker-compose -f docker-compose.dev.yml up -d
```

## Docker Commands

### Building Images

```bash
# Build development image
npm run docker:build

# Build production image (optimized)
npm run docker:build:prod
```

### Running Containers

```bash
# Run single container
npm run docker:run

# Start with docker-compose (production)
npm run docker:up

# Start with docker-compose (development)
npm run docker:up:dev
```

### Managing Services

```bash
# View logs
npm run docker:logs

# Stop services
npm run docker:down

# Clean up (remove containers and volumes)
npm run docker:clean
```

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `NODE_ENV` | `production` | Runtime environment |
| `PORT` | `3000` | HTTP server port |
| `HOST` | `0.0.0.0` | Bind address |
| `WORKSPACE_PATH` | **Required** | Path to codebase for analysis |
| `LOG_LEVEL` | `info` | Logging level (debug, info, warn, error) |
| `CORS_ORIGIN` | `*` | CORS allowed origins |
| `MAX_FILE_SIZE_MB` | `10` | Maximum file size for analysis |

### Volume Mounts

- `/workspace` - Your codebase (read-only)
- `/project` - Specific project directory (read-only)
- `/app/data` - Persistent storage for file trees and configurations
- `/app/config` - Custom configuration files (optional)

## Health Checks

The container includes automatic health checks:

```bash
# Check health status
docker exec filescope-mcp curl http://localhost:3000/health
```

Expected response:
```json
{
  "status": "healthy",
  "service": "FileScopeMCP",
  "version": "1.0.0",
  "timestamp": "2025-09-15T09:00:00.000Z",
  "transport": "http"
}
```

## MCP Client Connection

### Claude Desktop

Add to your MCP settings:
```json
{
  "mcpServers": {
    "filescope-mcp": {
      "command": "docker",
      "args": [
        "run", "--rm", "-p", "3000:3000",
        "--env-file", ".env",
        "-v", "${WORKSPACE_PATH}:/workspace:ro",
        "filescope-mcp:production"
      ]
    }
  }
}
```

### HTTP Client

```bash
# Initialize MCP session
curl -X POST http://localhost:3000/mcp \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "initialize",
    "params": {
      "protocolVersion": "2024-11-05",
      "capabilities": {},
      "clientInfo": {
        "name": "test-client",
        "version": "1.0.0"
      }
    }
  }'
```

## Production Deployment

### Resource Requirements

**Minimum:**
- CPU: 0.1 cores
- Memory: 256MB
- Storage: 100MB + data volume

**Recommended:**
- CPU: 0.5 cores
- Memory: 1GB
- Storage: 1GB + data volume

### Security Considerations

1. **Non-root user**: Containers run as `filescope` user
2. **Read-only workspace**: Your codebase is mounted read-only
3. **Network isolation**: Uses dedicated Docker network
4. **Resource limits**: CPU and memory limits configured

### Backup and Persistence

Data is stored in Docker volumes:
```bash
# Backup data volume
docker run --rm -v filescope_data:/data -v $(pwd):/backup alpine tar czf /backup/filescope-backup.tar.gz -C /data .

# Restore data volume
docker run --rm -v filescope_data:/data -v $(pwd):/backup alpine tar xzf /backup/filescope-backup.tar.gz -C /data
```

## Troubleshooting

### Common Issues

**Container fails to start:**
```bash
# Check logs
docker-compose logs filescope-mcp

# Check health
docker exec filescope-mcp curl http://localhost:3000/health
```

**Permission errors:**
```bash
# Ensure correct ownership
sudo chown -R 1000:1000 /path/to/workspace
```

**Port conflicts:**
```bash
# Change port in .env
PORT=3001

# Restart services
docker-compose down && docker-compose up -d
```

### Debug Mode

Enable debug logging:
```bash
# Set in .env
LOG_LEVEL=debug
DEBUG=*

# Restart container
docker-compose restart filescope-mcp
```

## Development

### Hot Reload Development

```bash
# Start development environment
docker-compose -f docker-compose.dev.yml up -d

# View logs
docker-compose -f docker-compose.dev.yml logs -f

# Debug with Node.js inspector (port 9229)
chrome://inspect
```

### Building from Source

```bash
# Clone repository
git clone <repository-url>
cd FileScopeMCP

# Install dependencies
npm install

# Build
npm run build

# Build Docker image
npm run docker:build
```

## Support

For issues and questions:
- Check logs: `npm run docker:logs`
- Health check: `curl http://localhost:3000/health`
- GitHub Issues: [Create an issue](link-to-repo)

---

**Note**: This deployment guide assumes you have Docker and Docker Compose properly installed and configured on your system.
