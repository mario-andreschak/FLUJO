# MCP API Layer

This directory contains the API layer for the Model Context Protocol (MCP) implementation. The API layer serves as an interface between the frontend and backend services.

## Architecture

The MCP implementation follows a clean architecture pattern with clear separation of concerns:

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│                 │     │                 │     │                 │
│  UI Components  │◄───►│  Frontend       │◄───►│  API Layer      │◄───┐
│                 │     │  Service        │     │  (Adapters)     │    │
└─────────────────┘     └─────────────────┘     └─────────────────┘    │
                                                        │               │
                                                        ▼               │
                                                ┌─────────────────┐     │
                                                │                 │     │
                                                │  Backend        │◄────┘
                                                │  Service        │
                                                └─────────────────┘
```

## Components

### API Handlers

- `handlers.ts`: Contains the HTTP request handlers for the API endpoints
- `route.ts`: Exports the handlers and initializes the backend service

### Adapters

The API layer uses the adapter pattern to delegate calls to the backend service:

- `config-adapter.ts`: Adapts configuration-related operations
- `tools-adapter.ts`: Adapts tool-related operations
- `connection-adapter.ts`: Adapts connection-related operations

### Legacy Modules

These modules are maintained for backward compatibility but delegate to the adapters:

- `config.ts`: Configuration operations
- `tools.ts`: Tool operations
- `connection.ts`: Connection operations

## Flow of Control

1. Frontend components use the frontend service to make API calls
2. Frontend service makes HTTP requests to the API endpoints
3. API handlers process the requests and delegate to the backend service
4. Backend service performs the operations and returns the results
5. API handlers format the results and return them to the frontend

## Refactoring Notes

This architecture was refactored to eliminate circular dependencies between the API layer and the backend service. The key changes were:

1. Moving core functionality from the API layer to the backend service
2. Creating adapter modules in the API layer to delegate to the backend service
3. Maintaining backward compatibility through the legacy modules

## Benefits

- **Clean Architecture**: Clear separation of concerns between layers
- **No Circular Dependencies**: Each layer only depends on the layer below it
- **Maintainability**: Each component has a single responsibility
- **Testability**: Components can be tested in isolation
- **Extensibility**: New features can be added without modifying existing code

## Usage

The API layer should not be used directly by frontend components. Instead, frontend components should use the frontend service, which will make the appropriate API calls.

```typescript
// Frontend component
import { mcpService } from '@/frontend/services/mcp';

// Call a method on the frontend service
const result = await mcpService.callTool('serverName', 'toolName', { arg1: 'value1' });
```

The frontend service will make an API call to the appropriate endpoint, which will be handled by the API layer and delegated to the backend service.
