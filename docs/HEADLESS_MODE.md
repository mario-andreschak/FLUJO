# FLUJO Headless Mode

FLUJO can run in a headless mode without a GUI, which is perfect for servers or environments where you want to use FLUJO as an API service.

## Running in Headless Mode

### Basic Headless Mode

```bash
npm run headless
```

This starts FLUJO without a GUI, running only the Next.js server that provides the API functionality.

### Headless Mode with Memory Optimization

```bash
npm run headless-optimize
```

This enables the V8 garbage collector (`--expose-gc`) for better memory management, which is recommended for long-running server instances.

### Headless Mode with Auto-Shutdown

```bash
npm run headless-timeout
```

Automatically shuts down the server after 60 minutes.

## API Endpoints

When running in headless mode, FLUJO exposes several API endpoints:

### OpenAI-Compatible API

- **Endpoint**: `http://localhost:4200/v1/chat/completions`
- **Method**: POST
- **Format**: Compatible with OpenAI Chat Completions API
- **Model Parameter**: Use `flow-[FlowName]` to specify which flow to execute

Example:

```bash
curl -X POST http://localhost:4200/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model": "flow-MyFlow", "messages": [{"role": "user", "content": "Hello"}]}'
```

### Status API

- **Endpoint**: `http://localhost:4201/status`
- **Method**: GET
- **Returns**: JSON with server status information

Example:

```bash
curl http://localhost:4201/status
```

## Network Access

By default, FLUJO binds to localhost (127.0.0.1) and is only accessible from the local machine. To make it accessible from other machines on the network:

```bash
FLUJO_NETWORK_MODE=1 npm run headless
```

## Security Considerations

When exposing FLUJO to a network:

1. Consider adding authentication
2. Use a reverse proxy like Nginx for SSL/TLS
3. Configure firewall rules to restrict access 