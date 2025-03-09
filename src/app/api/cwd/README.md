# Current Working Directory API

This directory contains the API endpoint for retrieving the current working directory and related path information.

## Architecture

The Current Working Directory API follows a simple architecture:

```
┌─────────────────┐     ┌─────────────────┐
│                 │     │                 │
│  Frontend       │◄───►│  API Layer      │
│  Components     │     │  (route.ts)     │
└─────────────────┘     └─────────────────┘
```

## Components

### API Handler

- `route.ts`: Handles HTTP GET requests to retrieve the current working directory and MCP servers directory path

## Flow of Control

1. Frontend components make a GET request to the API endpoint
2. API handler retrieves the current working directory using `process.cwd()`
3. API handler calculates the MCP servers directory path
4. Results are returned to the frontend

## API Endpoints

### GET /api/cwd

Returns the current working directory and MCP servers directory path.

#### Response

```json
{
  "success": true,
  "cwd": "/path/to/current/working/directory",
  "mcpServersDir": "/path/to/current/working/directory/mcp-servers"
}
```

#### Error Response

```json
{
  "success": false,
  "error": "Error message"
}
```

## Usage Examples

### Frontend Usage

```typescript
// Get the current working directory
const response = await fetch('/api/cwd');
const data = await response.json();

if (data.success) {
  // Access the current working directory
  const cwd = data.cwd;
  
  // Access the MCP servers directory
  const mcpServersDir = data.mcpServersDir;
  
  console.log(`Current working directory: ${cwd}`);
  console.log(`MCP servers directory: ${mcpServersDir}`);
} else {
  console.error(`Error: ${data.error}`);
}
```

## Error Handling

The API returns appropriate HTTP status codes and error messages:

- `200 OK`: Successful response with directory information
- `500 Internal Server Error`: Server-side errors

Error responses include a descriptive message and a `success: false` flag:

```json
{
  "success": false,
  "error": "Failed to get current working directory: Error message"
}
```

## Security Considerations

This API only provides read-only access to directory paths and does not expose any sensitive information. It is used primarily for internal application functionality to determine the correct paths for MCP server operations.
