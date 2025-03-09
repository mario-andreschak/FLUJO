# MCP Service

This directory contains the Model Context Protocol (MCP) service implementation for the frontend component of the application.

## Overview

The MCP Service provides a standardized interface for interacting with Model Context Protocol servers. It enables the application to:

- Discover and execute tools provided by MCP servers
- Manage server configurations
- Monitor server status and handle errors
- Subscribe to server events
- Provide a consistent API for frontend components

## Architecture

The MCP Service is split into two main components:

1. **Backend Service** (`src/backend/services/mcp/index.ts`): Handles direct communication with MCP servers, manages connections, and maintains server state.
2. **Frontend Service** (`src/frontend/services/mcp/index.ts`): Provides a client-side API for UI components to interact with MCP servers through the backend API.

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│                 │     │                 │     │                 │
│  UI Components  │◄───►│  MCP Frontend   │◄───►│   MCP Backend   │◄───┐
│                 │     │    Service      │     │    Service      │    │
└─────────────────┘     └─────────────────┘     └─────────────────┘    │
                                                                       │
                                                                       ▼
                                                          ┌─────────────────────┐
                                                          │                     │
                                                          │   MCP Servers       │
                                                          │                     │
                                                          └─────────────────────┘
```

## Frontend Service (index.ts)

The frontend service provides a client-side API for UI components to interact with MCP servers through the backend API. It is responsible for:

- Providing a clean interface for UI components
- Making API calls to the backend service
- Handling errors and providing user feedback
- Managing server events through SSE (Server-Sent Events)

### Key Features

- **Server Configuration Management**: Load, update, and delete server configurations
- **Tool Discovery and Execution**: List and execute tools on connected servers
- **Server Status Monitoring**: Check server status and handle connection issues
- **Event Subscription**: Subscribe to server events using SSE
- **Error Handling**: User-friendly error handling and feedback

### Core Components

- `MCPService` class: Main service class that provides methods for server management
- API calls to backend endpoints
- Server event subscription
- Error handling and user feedback

## Service Synergy

The backend and frontend services work together to provide a seamless experience for both developers and users:

### State Management

- **Backend as Source of Truth**: The backend maintains the actual connection state and server configurations
- **Frontend as View Layer**: The frontend provides a clean API for UI components to interact with the backend

### Error Handling

- **Backend**: Detailed error logging and technical error messages
- **Frontend**: User-friendly error messages and feedback
- **Error Propagation**: Errors are propagated from the backend to the frontend with appropriate context

### Configuration Management

- **Backend**: Handles persistence and validation of server configurations
- **Frontend**: Provides a clean API for updating configurations and handling user input

### Tool Execution

- **Backend**: Handles direct communication with MCP servers for tool execution
- **Frontend**: Provides a clean API for UI components to discover and execute tools

## Usage Examples

### Frontend Service

```typescript
// Import the service
import { mcpService } from '@/frontend/services/mcp';

// Load server configurations
const configs = await mcpService.loadServerConfigs();

// List tools from a server
const tools = await mcpService.listServerTools('serverName');

// Call a tool on a server
const toolResult = await mcpService.callTool('serverName', 'toolName', { arg1: 'value1' });

// Update a server configuration
const updatedConfig = await mcpService.updateServerConfig('serverName', {
  command: 'new-command',
  args: ['--arg1', 'value1'],
});

// Get server status
const status = await mcpService.getServerStatus('serverName');

// Delete a server configuration
await mcpService.deleteServerConfig('serverName');

// Retry connecting to a server
await mcpService.retryServer('serverName');

// Restart a server
await mcpService.restartServer('serverName');

// Subscribe to server events
const cleanup = mcpService.subscribeToServerEvents('serverName', (event) => {
  console.log('Server event:', event);
});

// Cleanup subscription when done
cleanup();
```

## API Reference

### Frontend Service

#### Server Management

- `loadServerConfigs()`: Load server configurations from the backend
- `getServerStatus(serverName)`: Get the status of an MCP server
- `retryServer(serverName)`: Retry connecting to a server
- `restartServer(serverName)`: Restart a server

#### Configuration Management

- `updateServerConfig(serverName, updates)`: Update a server configuration
- `deleteServerConfig(serverName)`: Delete a server configuration

#### Tool Management

- `listServerTools(serverName)`: List tools available from an MCP server
- `callTool(serverName, toolName, args, timeout?)`: Call a tool on an MCP server

#### Event Management

- `subscribeToServerEvents(serverName, callback)`: Subscribe to server events

## Best Practices

### Server Management

1. **Graceful Error Handling**: Always handle server errors gracefully and provide meaningful error messages to users
2. **Status Monitoring**: Regularly check server status to ensure servers are still connected
3. **Retry Logic**: Implement retry logic for transient errors
4. **Restart Capability**: Provide a way to restart servers when needed

### Error Handling

1. **User-Friendly Errors**: Convert technical error messages to user-friendly messages
2. **Error Context**: Include context in error messages, such as server name and operation being performed
3. **Error Logging**: Log all errors for debugging and troubleshooting
4. **Error Recovery**: Provide ways for users to recover from errors

### Configuration Management

1. **Validation**: Validate server configurations before saving them
2. **Defaults**: Provide sensible defaults for configuration options
3. **Environment Variables**: Support environment variables in server configurations
4. **Persistence**: Ensure configurations are persisted correctly

### Tool Execution

1. **Timeout Handling**: Implement timeouts for tool execution to prevent hanging operations
2. **Argument Validation**: Validate tool arguments before sending them to servers
3. **Result Handling**: Handle tool execution results appropriately, including errors
4. **Caching**: Consider caching tool lists to improve performance

### Event Management

1. **Subscription Cleanup**: Always clean up event subscriptions when they are no longer needed
2. **Error Handling**: Handle errors in event subscriptions gracefully
3. **Reconnection Logic**: Implement reconnection logic for event subscriptions
4. **Event Filtering**: Filter events to only process relevant ones

## Troubleshooting

### Common Issues

1. **Server Connection Failures**: Check server command, arguments, and environment variables
2. **Tool Execution Errors**: Verify tool arguments and server connection status
3. **Configuration Issues**: Ensure server configurations are valid and complete
4. **Event Subscription Issues**: Check if SSE is enabled and the server is connected

### Debugging

1. **API Calls**: Check the network tab in browser developer tools to see API calls and responses
2. **Server Status**: Use `getServerStatus()` to check server connection status
3. **Tool List**: Use `listServerTools()` to verify server is responding correctly
4. **Manual Testing**: Test server connections and tool execution manually
