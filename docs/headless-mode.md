# FLUJO Headless Mode

FLUJO can run in headless mode without a GUI, providing an API server for integrating with other applications or deploying as a service.

## Running in Headless Mode

### Basic Headless Mode

```bash
npm run headless
```

This starts FLUJO without a GUI, running only the API server on port 4200 (default).

### Memory Optimization

```bash
npm run headless-optimize
```

This enables the V8 garbage collector (`--expose-gc`) for better memory management, recommended for long-running server instances.

### Auto-Shutdown

```bash
npm run headless-timeout
```

Automatically shuts down the server after 60 minutes.

You can customize the timeout duration:

```bash
electron . --headless --timeout=30
```

## API Documentation

For interactive API documentation, start FLUJO with the `--docs` flag:

```bash
npm run headless-docs
```

### Accessing Documentation

Once the server is running with the `--docs` flag, you can access the documentation:

1. **Using npm scripts**:

   - `npm run open-docs` - Opens the interactive Swagger UI
   - `npm run open-docs:api` - Opens the raw OpenAPI specification JSON

2. **Direct URLs**:
   - Swagger UI: `http://localhost:4200/docs/swagger`
   - OpenAPI JSON: `http://localhost:4200/api/docs`

## Managing the Headless Server

### Shutting Down

To gracefully shut down a running headless server:

```bash
npm run headless-shutdown
```

You can also shut down programmatically with a POST request:

```
POST http://localhost:4201/shutdown
Content-Type: application/json

{
  "action": "shutdown"
}
```

### Status Endpoint

Get information about the running server:

```
GET http://localhost:4201/status
```

Returns information including:

- Current status
- Operation mode (headless/gui)
- Uptime in seconds
- Server port
- API documentation status
- Application version
- Documentation URL (if enabled)

Example:

```bash
curl http://localhost:4201/status
```

## API Endpoints

### 1. OpenAI-Compatible API

- **Endpoint**: `http://localhost:4200/v1/chat/completions`
- **Method**: POST
- **Format**: Compatible with OpenAI Chat Completions API

Example request:

```json
{
  "model": "flow:YourFlowName",
  "messages": [{ "role": "user", "content": "Your message here" }],
  "temperature": 1.0,
  "max_tokens": 1000
}
```

Example using curl:

```bash
curl -X POST http://localhost:4200/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model": "flow:YourFlowName", "messages": [{"role": "user", "content": "Hello"}]}'
```

### 2. Native FLUJO API

- **Endpoint**: `http://localhost:4200/api/flow/execute/{flowName}`
- **Method**: POST

Example request:

```json
{
  "messages": [{ "role": "user", "content": "Your message here" }]
}
```

## Network Access

By default, FLUJO binds to localhost and is only accessible from the local machine. To make it accessible from other machines:

```bash
FLUJO_NETWORK_MODE=1 npm run headless
```

The server will then display all available network interfaces in the console output.

## Security Considerations

When exposing FLUJO to a network:

1. Consider adding authentication
2. Use a reverse proxy like Nginx for SSL/TLS
3. Configure firewall rules to restrict access

## Troubleshooting

If you encounter issues with the API server:

1. Check that the server is running and listening on the expected port
2. Verify that your flow exists and is correctly configured
3. Check the console output for any error messages
4. Use the status endpoint to confirm the server is responding
