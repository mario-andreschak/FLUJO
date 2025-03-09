# MCP Service

This directory contains the Model Context Protocol (MCP) service implementation for the backend component of the application.

## Overview

The MCP Service provides a standardized interface for interacting with Model Context Protocol servers. It enables the application to:

- Connect to and manage MCP servers
- Discover and execute tools provided by MCP servers
- Manage server configurations
- Monitor server status and handle errors
- Provide a consistent API for backend components

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

## Backend Service (index.ts)

The backend service is responsible for:

- Managing MCP server connections
- Storing and retrieving server configurations
- Executing tools on connected servers
- Monitoring server status
- Handling errors and logging

### Key Features

- **Server Connection Management**: Connect to, disconnect from, and monitor MCP servers
- **Configuration Persistence**: Save and load server configurations
- **Tool Execution**: Discover and execute tools on connected servers
- **Error Handling**: Comprehensive error handling with detailed error messages
- **Logging**: Detailed logging of server operations and errors
- **Automatic Server Startup**: Automatically connect to enabled servers on application startup

### Core Components

- `MCPService` class: Main service class that provides methods for server management
- Server configuration storage and retrieval
- Tool discovery and execution
- Connection state management
- Error handling and logging

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

### Backend Service

```typescript
// Import the service
import { mcpService } from '@/backend/services/mcp';

// Load server configurations
const configs = await mcpService.loadServerConfigs();

// Connect to a server
const result = await mcpService.connectServer('serverName');

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

// Disconnect from a server
await mcpService.disconnectServer('serverName');

// Delete a server configuration
await mcpService.deleteServerConfig('serverName');
```

## API Reference

### Backend Service

#### Server Management

- `loadServerConfigs()`: Load server configurations from storage
- `connectServer(serverName | config)`: Connect to an MCP server
- `disconnectServer(serverName)`: Disconnect from an MCP server
- `getServerStatus(serverName)`: Get the status of an MCP server
- `startEnabledServers()`: Start all enabled servers

#### Configuration Management

- `updateServerConfig(serverName, updates)`: Update a server configuration
- `deleteServerConfig(serverName)`: Delete a server configuration

#### Tool Management

- `listServerTools(serverName)`: List tools available from an MCP server
- `callTool(serverName, toolName, args, timeout?)`: Call a tool on an MCP server

## Best Practices

### Server Management

1. **Graceful Connection Handling**: Always handle connection errors gracefully and provide meaningful error messages to users
2. **Automatic Reconnection**: Implement automatic reconnection for transient errors
3. **Server Status Monitoring**: Regularly check server status to ensure servers are still connected
4. **Resource Cleanup**: Always clean up resources when disconnecting from servers

### Error Handling

1. **Detailed Error Messages**: Provide detailed error messages that help users understand and fix issues
2. **Error Context**: Include context in error messages, such as server name and operation being performed
3. **User-Friendly Errors**: Convert technical error messages to user-friendly messages in the frontend
4. **Error Logging**: Log all errors for debugging and troubleshooting

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

### Security

1. **Input Validation**: Validate all user input before sending it to servers
2. **Environment Variables**: Securely handle sensitive environment variables
3. **Error Messages**: Avoid exposing sensitive information in error messages
4. **Authentication**: Implement authentication for server connections if needed

## Troubleshooting

### Common Issues

1. **Server Connection Failures**: Check server command, arguments, and environment variables
2. **Tool Execution Errors**: Verify tool arguments and server connection status
3. **Configuration Issues**: Ensure server configurations are valid and complete
4. **Event Subscription Issues**: Check if SSE is enabled and the server is connected

### Debugging

1. **Logging**: Check the logs for detailed error messages and debugging information
2. **Server Status**: Use `getServerStatus()` to check server connection status
3. **Tool List**: Use `listServerTools()` to verify server is responding correctly
4. **Manual Testing**: Test server connections and tool execution manually
