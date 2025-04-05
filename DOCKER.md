# Docker Support for Flujo

This document provides detailed information about running Flujo in a Docker container.

## Overview

Flujo can be run in a Docker container, which provides several benefits:

- Consistent environment across different platforms
- Isolation from the host system
- Easy deployment
- Support for running Docker-based MCP servers within Flujo

## Prerequisites

- Docker installed on your system
- Docker Compose (optional, but recommended)

## Quick Start

### Using Docker Compose (Recommended)

1. Clone the repository:
   ```bash
   git clone https://github.com/mario-andreschak/FLUJO.git
   cd FLUJO
   ```

2. Build and start the container:
   ```bash
   docker-compose up -d
   ```

3. Access Flujo in your browser:
   ```
   http://localhost:4200
   ```

### Using Docker Scripts

For more control over the Docker build and run process, you can use the provided scripts:

1. Build the Docker image:
   ```bash
   ./scripts/build-docker.sh
   ```

   Options:
   - `--verbose`: Show build output in the terminal
   - `--tag=<tag>`: Specify a custom tag for the image (default: latest)

2. Run the Docker container:
   ```bash
   ./scripts/run-docker.sh
   ```

   Options:
   - `--detached`: Run in detached mode
   - `--no-privileged`: Run without privileged mode (not recommended)
   - `--port=<port>`: Specify the host port (default: 4200)
   - `--tag=<tag>`: Specify the image tag to run (default: latest)

## Docker-in-Docker Support

Flujo's Docker container includes Docker-in-Docker (DinD) support, which allows you to run Docker-based MCP servers within the Flujo container. This is achieved by running the Docker daemon inside the container.

### How it Works

1. The Docker container is started with the `--privileged` flag, which is required for Docker-in-Docker.
2. The Docker daemon is started inside the container when it launches.
3. Flujo can then use this Docker daemon to run Docker-based MCP servers.

### Security Considerations

Running containers in privileged mode has security implications. The container has full access to the host system, which could be a security risk. Use this feature only in trusted environments.

## Persistent Storage

Flujo uses a Docker volume to persist data between container restarts. By default, this volume is mounted at `/app/data` inside the container.

The data that is persisted includes:
- MCP server configurations
- Model configurations
- Flow definitions
- Environment variables and API keys

## Customization

### Environment Variables

You can customize the Flujo container by setting environment variables in the `docker-compose.yml` file:

```yaml
services:
  flujo:
    environment:
      - NODE_ENV=production
      # Add your custom environment variables here
```

### Custom Volumes

You can add additional volume mounts in the `docker-compose.yml` file:

```yaml
services:
  flujo:
    volumes:
      - flujo-data:/app/data  # Default volume for persistent storage
      # Add your custom volumes here
```

## Troubleshooting

### Container Fails to Start

If the container fails to start, check the logs:

```bash
docker logs flujo
```

Common issues:
- Port 4200 is already in use: Change the port mapping in `docker-compose.yml` or use the `--port` option with `run-docker.sh`.
- Insufficient permissions: Make sure you're running Docker with appropriate permissions.

### Cannot Connect to Flujo

If you can't connect to Flujo in your browser:
- Check if the container is running: `docker ps | grep flujo`
- Check the logs for any errors: `docker logs flujo`
- Make sure you're using the correct port: By default, Flujo is accessible at `http://localhost:4200`

## Building Custom Images

You can build custom Flujo Docker images by modifying the Dockerfile. The Dockerfile uses a multi-stage build process:

1. **Prepare Stage**: Prepares the package.json for Docker by removing Electron-related dependencies.
2. **Build Stage**: Builds the Next.js application.
3. **Runtime Stage**: Sets up the Docker-in-Docker environment and runs the application.

To build a custom image:

1. Modify the Dockerfile as needed.
2. Build the image:
   ```bash
   docker build -t flujo:custom .
   ```
3. Run the custom image:
   ```bash
   docker run -d --privileged -p 4200:4200 -v flujo-data:/app/data --name flujo flujo:custom
