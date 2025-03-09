# Server-Sent Events (SSE) API

This directory contains the API endpoint for Server-Sent Events (SSE), which enables real-time communication with MCP servers.

## Architecture

The SSE API follows a clean architecture pattern with integration to the MCP client:

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│                 │     │                 │     │                 │
│  Frontend       │◄───►│  API Layer      │◄───►│  MCP Service    │
│  Components     │     │  (route.ts)     │     │                 │
└─────────────────┘     └─────────────────┘     └─────────────────┘
                               │
                               ▼
                        ┌─────────────────┐
                        │                 │
                        │  MCP Client     │
                        │  (SDK)          │
                        └─────────────────┘
```

## Components

### API Handler

- `route.ts`: Handles HTTP GET requests to establish SSE connections and POST requests to send messages to MCP servers

### Integration with Other Services

- **MCP Service**: Manages MCP client connections
- **MCP SDK**: Provides client implementation for the Model Context Protocol

## Flow of Control

### SSE Connection Establishment

1. Frontend components make a GET request to establish an SSE connection
2. API handler validates the request parameters
3. API handler creates or retrieves an MCP client based on the parameters
4. API handler establishes a stream and forwards messages from the MCP client to the frontend
5. When the connection is closed, the API handler properly cleans up resources

### Message Sending

1. Frontend components make a POST request to send a message to an MCP server
2. API handler validates the request parameters
3. API handler retrieves the MCP client for the specified server
4. API handler forwards the message to the MCP server

## API Endpoints

### GET /api/sse

Establishes an SSE connection for real-time communication with an MCP server.

#### Query Parameters

- `transportType` (optional): The type of transport to use (`stdio` or `websocket`)
- `command` (required for stdio): The command to execute for stdio transport
- `args` (optional for stdio): Command arguments
- `env` (optional for stdio): Environment variables as JSON string
- `serverName` (optional): Name of an existing MCP server
- `url` (required for websocket): WebSocket URL for websocket transport

#### Response

The response is an SSE stream with the following event types:

- `endpoint`: Contains the endpoint URL for sending messages back to the server
- JSON-RPC messages from the MCP server
- Error events from stderr

### POST /api/sse

Sends a message to an MCP server.

#### Query Parameters

- `serverName` (required): Name of the MCP server to send the message to

#### Request Body

A JSON-RPC message to send to the server:

```json
{
  "jsonrpc": "2.0",
  "method": "method_name",
  "params": { ... },
  "id": 1
}
```

or for notifications:

```json
{
  "jsonrpc": "2.0",
  "method": "method_name",
  "params": { ... }
}
```

## Feature Flags

The SSE API can be enabled or disabled using the `SSE_ENABLED` feature flag in the application configuration. When disabled, the API returns a 503 Service Unavailable response.

## Error Handling

The API returns appropriate HTTP status codes and error messages:

- `400 Bad Request`: Missing or invalid parameters
- `404 Not Found`: Server not found or not connected
- `500 Internal Server Error`: Server-side errors
- `503 Service Unavailable`: SSE functionality disabled via feature flag

Error responses include a descriptive message:

```json
{
  "error": "Error message"
}
```

## Usage Examples

### Establishing an SSE Connection

```typescript
// Create an EventSource for an existing MCP server
const eventSource = new EventSource('/api/sse?serverName=my-server');

// Or create a new stdio transport
const eventSource = new EventSource('/api/sse?transportType=stdio&command=node%20server.js&args=--port%203000');

// Or create a new websocket transport
const eventSource = new EventSource('/api/sse?transportType=websocket&url=ws://localhost:8080');

// Handle messages
eventSource.onmessage = (event) => {
  const data = JSON.parse(event.data);
  console.log('Received message:', data);
};

// Handle errors
eventSource.onerror = (error) => {
  console.error('SSE error:', error);
  eventSource.close();
};

// Handle specific event types
eventSource.addEventListener('endpoint', (event) => {
  const data = JSON.parse(event.data);
  console.log('Endpoint URL:', data.endpoint);
});
```

### Sending a Message

```typescript
// Send a message to an MCP server
const response = await fetch('/api/sse?serverName=my-server', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    jsonrpc: '2.0',
    method: 'list_tools',
    id: 1
  })
});

if (response.ok) {
  const data = await response.json();
  console.log('Response:', data);
} else {
  console.error('Error sending message:', await response.text());
}
```

## Security Considerations

### Process Management

The SSE API manages child processes for stdio transport, which requires careful handling:

1. **Graceful Shutdown**: Implements a proper shutdown sequence to avoid orphaned processes
2. **Timeout Handling**: Sets timeouts for process termination to prevent hanging processes
3. **Signal Handling**: Uses appropriate signals (SIGTERM, SIGKILL) for process termination

### Error Propagation

The API carefully manages error propagation:

1. **Selective Stderr Forwarding**: Only forwards critical errors from stderr to avoid leaking debug information
2. **Structured Error Events**: Formats errors as structured events with type information
3. **Logging**: Logs all errors for debugging while keeping sensitive information protected
