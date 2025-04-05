# Docker-Based MCP Servers

This document explains how to use Docker-based MCP servers in Flujo, including how to configure environment variables with proper security handling.

## Overview

Docker-based MCP servers allow you to run Model Context Protocol (MCP) servers in Docker containers, providing isolation, portability, and simplified deployment. Flujo supports running MCP servers in Docker containers with both STDIO and WebSocket transport methods.

## Adding a Docker-Based MCP Server

To add a Docker-based MCP server to Flujo:

1. Navigate to the MCP Manager in Flujo
2. Click the "Add Server" button
3. Select "Docker" as the server type
4. Configure the server settings as described below

## Configuration Options

### Basic Configuration

- **Server Name**: A unique name for your server
- **Docker Image**: The Docker image to use (e.g., `ghcr.io/github/github-mcp-server`)
- **Container Name** (Optional): A custom name for the Docker container
- **Transport Method**: Choose between STDIO and WebSocket
  - **STDIO**: Standard input/output communication (default)
  - **WebSocket**: WebSocket communication (requires specifying a port)

### Environment Variables

Docker-based MCP servers often require environment variables for configuration, such as API keys or authentication tokens. Flujo provides a secure way to manage these environment variables:

1. In the "Environment Variables" section, click "Add Variable"
2. Enter the variable name and value
3. For sensitive information like API keys or tokens, check the "Secret" checkbox
   - Secret variables will be masked in the UI to protect your credentials
   - The values will still be correctly passed to the Docker container

Example environment variables for a GitHub MCP server:
- `GITHUB_PERSONAL_ACCESS_TOKEN` (marked as secret)

### Advanced Configuration

- **Network Mode**: Specify a Docker network mode (e.g., `host`, `bridge`)
- **Volumes**: Add Docker volume mappings (e.g., `/host/path:/container/path`)
- **Additional Docker Run Arguments**: Specify additional arguments for `docker run`

## Troubleshooting

### Container Startup Issues

If you encounter issues with the Docker container not starting:

1. Check that the Docker image name is correct
2. Verify that the required environment variables are properly configured
3. Check Docker logs for any error messages: `docker logs <container-name>`

Flujo implements an exponential backoff strategy when checking container status, allowing up to 30 seconds for containers to start. If a container takes longer than expected to start, you may see a message indicating that the container is not running. In this case, try refreshing the server status after a few moments.

### Connection Issues

If the server connects but tools are not available:

1. Check that the transport method (STDIO or WebSocket) is correctly configured
2. For WebSocket transport, verify that the port is correctly specified and accessible
3. Check that the Docker container has the necessary permissions to run the MCP server

## Examples

### GitHub MCP Server

```
Server Name: github
Docker Image: ghcr.io/github/github-mcp-server
Transport Method: STDIO
Environment Variables:
  - GITHUB_PERSONAL_ACCESS_TOKEN: your-token-here (Secret)
```

### Custom MCP Server

```
Server Name: custom-server
Docker Image: your-registry/custom-mcp-server:latest
Transport Method: WebSocket
WebSocket Port: 8080
Environment Variables:
  - API_KEY: your-api-key (Secret)
  - CONFIG_PATH: /app/config.json
```
