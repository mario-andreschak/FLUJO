# MCP API Layer

This directory contains the RESTful HTTP API for the Model Context Protocol (MCP)
implementation. The API layer is a thin transport boundary between the frontend and the
backend MCP service (`@/backend/services/mcp`).

## Architecture

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│                 │     │                 │     │                 │     │                 │
│  UI Components  │◄───►│  Frontend       │◄───►│  REST routes    │◄───►│  Backend        │
│                 │     │  Service        │     │  (this dir)     │     │  Service        │
└─────────────────┘     └─────────────────┘     └─────────────────┘     └─────────────────┘
```

The route handlers do no business logic of their own — they parse the request, delegate to
`mcpService`, and map the result onto an HTTP status code.

## Endpoints

The MCP server configuration is modelled as a REST resource keyed by its (URL-encoded) name,
nested under `/servers`. The action routes (`test-connection`, `cancel`) live directly under
`/api/mcp`, outside the server namespace — see "Why `/servers`" below.

| Method   | Path                                          | Description                                          |
| -------- | --------------------------------------------- | ---------------------------------------------------- |
| `GET`    | `/api/mcp/servers`                            | List all server configs (returns an array).          |
| `POST`   | `/api/mcp/servers`                            | Create a server config (`409` if the name exists).   |
| `GET`    | `/api/mcp/servers/{name}`                     | Get a single server config (`404` if not found).     |
| `PUT`    | `/api/mcp/servers/{name}`                     | Update a server config (partial body is merged).     |
| `DELETE` | `/api/mcp/servers/{name}`                     | Delete a server config (disconnects it first).       |
| `GET`    | `/api/mcp/servers/{name}/status`              | Live connection status (always `200`).               |
| `GET`    | `/api/mcp/servers/{name}/tools`               | List tools exposed by the server.                    |
| `POST`   | `/api/mcp/servers/{name}/tools/{toolName}`    | Invoke a tool. Body: `{ args, timeout? }`.           |
| `POST`   | `/api/mcp/test-connection`                    | Test a (possibly unsaved) config. Body: the config.  |
| `POST`   | `/api/mcp/cancel?serverName=&token=`          | Cancel / force-cancel an in-flight tool execution.   |

### Why `/servers`?

The server **name** is the resource key and goes into the URL path. In the Next.js App Router,
static segments win over dynamic ones, so if server configs lived at `/api/mcp/{name}`, a server
named `cancel` or `test-connection` would be shadowed by those static action routes (its
`GET`/`PUT`/`DELETE` would hit the wrong handler). Nesting configs under `/servers/{name}` gives
the dynamic segment its own namespace with **no static siblings**, so no name can ever collide.

### Server name validation

Because the name is a path segment, `POST` (create) and `PUT` (rename) reject names that break
URL routing: empty, longer than 200 chars, `.`/`..`, or containing `/`, `\`, or control
characters. Spaces and unicode are allowed — they round-trip through `encodeURIComponent` fine.
Validation applies only to new create/rename; pre-existing names keep working.

### Notes

- **`PUT` is a merge + upsert.** The provided fields are merged onto the stored config, so
  callers can send a partial body (e.g. just `{ "disabled": true }` to toggle a server).
  Saving a config also drives connection state: `disabled: false` (re)connects the server,
  `disabled: true` disconnects it.
- **Status and tools never return a non-2xx for a down server.** A disconnected server is a
  normal state, surfaced in the response body (`status: "error"` / `{ tools: [], error }`),
  not as an HTTP error — only an internal failure produces `500`.
- **`test-connection` is unauthenticated by resource** because the config it tests may not be
  saved yet. It runs the real MCP handshake in the Next.js server process, so it can reach
  servers behind custom CAs and send custom headers (Authorization, X-SAP-*).

## Usage

Frontend components must not call these endpoints directly. They go through the frontend
service, which owns the HTTP details:

```typescript
import { mcpService } from '@/frontend/services/mcp';

const configs = await mcpService.loadServerConfigs();
const result  = await mcpService.callTool('serverName', 'toolName', { arg1: 'value1' });
```
