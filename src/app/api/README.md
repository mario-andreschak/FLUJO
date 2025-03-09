# FLUJO API Layer Documentation

This document provides a comprehensive overview of the API layer in FLUJO, which serves as the interface between the frontend components and backend services.

## Table of Contents

- [Introduction](#introduction)
- [Overall Architecture](#overall-architecture)
- [API Modules Overview](#api-modules-overview)
- [Detailed Module Documentation](#detailed-module-documentation)
  - [Backup API](#backup-api)
  - [Current Working Directory API](#current-working-directory-api)
  - [Encryption API](#encryption-api)
  - [Environment Variables API](#environment-variables-api)
  - [Flow API](#flow-api)
  - [Git Operations API](#git-operations-api)
  - [Initialization API](#initialization-api)
  - [MCP API](#mcp-api)
  - [Model API](#model-api)
  - [Restore API](#restore-api)
  - [Server-Sent Events (SSE) API](#server-sent-events-sse-api)
  - [Storage API](#storage-api)
- [Common Patterns and Best Practices](#common-patterns-and-best-practices)
- [Security Considerations](#security-considerations)
- [Error Handling](#error-handling)

## Introduction

The API layer in FLUJO provides a set of RESTful endpoints that enable the frontend components to interact with backend services. It serves as a bridge between the user interface and the underlying functionality, handling data validation, processing, and communication with various services.

The API layer is organized into modules, each responsible for a specific domain of functionality, such as model management, MCP server integration, storage operations, and more. This modular approach ensures separation of concerns and maintainability.

## Overall Architecture

The API layer follows a clean architecture pattern with clear separation of concerns:

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│                 │     │                 │     │                 │
│  UI Components  │◄───►│  Frontend       │◄───►│  API Layer      │◄───┐
│                 │     │  Services       │     │  (Adapters)     │    │
└─────────────────┘     └─────────────────┘     └─────────────────┘    │
                                                        │               │
                                                        ▼               │
                                                ┌─────────────────┐     │
                                                │                 │     │
                                                │  Backend        │◄────┘
                                                │  Services       │
                                                └─────────────────┘
```

Key components of this architecture:

1. **UI Components**: React components that provide the user interface
2. **Frontend Services**: TypeScript modules that encapsulate API calls
3. **API Layer**: Next.js API routes that handle HTTP requests
4. **Backend Services**: Core business logic implementation

This architecture provides several benefits:

- **Clean Separation**: Each layer has a single responsibility
- **No Circular Dependencies**: Each layer only depends on the layer below it
- **Maintainability**: Components can be modified independently
- **Testability**: Each layer can be tested in isolation
- **Extensibility**: New features can be added without modifying existing code

## API Modules Overview

The API layer consists of the following modules:

| Module | Description |
|--------|-------------|
| **Backup** | Creates backups of application data |
| **CWD** | Retrieves current working directory information |
| **Encryption** | Provides secure encryption and decryption services |
| **Environment Variables** | Manages environment variables with encryption support |
| **Flow** | Handles flow definition and execution |
| **Git** | Performs Git operations for MCP server repositories |
| **Init** | Initializes the application |
| **MCP** | Manages Model Context Protocol servers and connections |
| **Model** | Handles model configuration and generation |
| **Restore** | Restores application data from backups |
| **SSE** | Provides Server-Sent Events for real-time communication |
| **Storage** | Manages application storage |

## Detailed Module Documentation

### Backup API

The Backup API creates backups of application data, including storage files and MCP server repositories.

#### Endpoints

- **POST /api/backup**: Creates a backup of selected application data

#### Request Body

```json
{
  "selections": [
    "models",
    "mcpServers",
    "flows",
    "chatHistory",
    "settings",
    "globalEnvVars",
    "encryptionKey",
    "mcpServersFolder"
  ]
}
```

#### Response

The response is a ZIP file with the following headers:

```
Content-Type: application/zip
Content-Disposition: attachment; filename=flujo-backup.zip
```

#### Backup Structure

- `backup-info.json`: Metadata about the backup
- `storage/`: Directory containing storage files
- `mcp-servers/`: Directory containing MCP server repositories (if selected)

### Current Working Directory API

The Current Working Directory API retrieves information about the current working directory and MCP servers directory.

#### Endpoints

- **GET /api/cwd**: Returns the current working directory and MCP servers directory path

#### Response

```json
{
  "success": true,
  "cwd": "/path/to/current/working/directory",
  "mcpServersDir": "/path/to/current/working/directory/mcp-servers"
}
```

### Encryption API

The Encryption API provides secure encryption and decryption services for sensitive data.

#### Endpoints

- **POST /api/encryption/secure**: Performs various encryption operations

#### Actions

- **initialize**: Initializes the encryption system with a user-defined password
- **initialize_default**: Initializes the encryption system with default encryption
- **change_password**: Changes the encryption password
- **authenticate**: Authenticates with a password and returns a session token
- **logout**: Invalidates a session token
- **encrypt**: Encrypts data using a session token, password, or default encryption
- **decrypt**: Decrypts data using a session token, password, or default encryption
- **verify_password**: Verifies if a password is correct and returns a session token
- **check_initialized**: Checks if encryption is initialized
- **check_user_encryption**: Checks if user encryption is enabled
- **get_encryption_type**: Returns the current encryption type

#### Security Features

- **Two-Tier Encryption**: Supports both default and user-defined encryption
- **Data Encryption Key (DEK)**: Uses a random key encrypted with the user's password
- **Secure Key Derivation**: Uses PBKDF2 with 100,000 iterations
- **Session-Based Authentication**: Uses secure session tokens instead of storing passwords
- **Token Expiration**: Sessions automatically expire after 2 hours of inactivity

### Environment Variables API

The Environment Variables API manages environment variables with secure encryption support.

#### Endpoints

- **GET /api/env**: Retrieves environment variables
- **POST /api/env**: Sets or deletes environment variables

#### Security Features

- **Automatic Encryption**: Automatically detects and encrypts sensitive variables
- **Secure Retrieval**: By default, returns placeholders for sensitive values
- **Explicit Decryption**: Only decrypts sensitive values when explicitly requested

### Flow API

The Flow API manages flow definitions and execution.

#### Endpoints

- **GET /api/flow?action=listFlows**: Lists all flows
- **GET /api/flow?action=getFlow&id={flowId}**: Gets a specific flow
- **POST /api/flow**: Performs various flow operations

#### Actions

- **addFlow**: Adds a new flow
- **updateFlow**: Updates an existing flow
- **deleteFlow**: Deletes a flow
- **createNewFlow**: Creates a new flow with default nodes
- **generateSampleFlow**: Generates a sample flow for testing

### Git Operations API

The Git Operations API performs Git operations for MCP server repositories.

#### Endpoints

- **POST /api/git**: Performs various Git operations

#### Actions

- **clone**: Clones a Git repository
- **install**: Runs installation commands in a repository
- **build**: Runs build commands in a repository
- **run**: Runs commands in a repository
- **readFile**: Reads a file from a repository
- **list**: Lists all repositories

### Initialization API

The Initialization API performs essential startup tasks when the application is first loaded.

#### Endpoints

- **GET /api/init**: Initializes the application

#### Initialization Tasks

- **Storage Verification**: Ensures the storage system is properly set up
- **Directory Creation**: Creates necessary directories if they don't exist
- **File Verification**: Verifies storage files are accessible

### MCP API

The MCP API manages Model Context Protocol servers and connections.

#### Architecture

The MCP API uses the adapter pattern to delegate calls to the backend service:

- **config-adapter.ts**: Adapts configuration-related operations
- **tools-adapter.ts**: Adapts tool-related operations
- **connection-adapter.ts**: Adapts connection-related operations

#### Legacy Modules

These modules are maintained for backward compatibility:

- **config.ts**: Configuration operations
- **tools.ts**: Tool operations
- **connection.ts**: Connection operations

### Model API

The Model API manages model configurations and generation.

#### Endpoints

- **GET /api/model**: Performs various model operations
- **POST /api/model**: Performs various model operations

#### GET Actions

- **fetchModels**: Fetches models from a provider
- **fetchOpenRouterModels**: Fetches models from OpenRouter (legacy)
- **listModels**: Lists all models
- **getModel**: Gets a specific model
- **checkEncryption**: Checks encryption status

#### POST Actions

- **generateCompletion**: Generates a completion
- **addModel**: Adds a new model
- **updateModel**: Updates an existing model
- **deleteModel**: Deletes a model
- **setEncryptionKey**: Sets encryption key
- **encryptApiKey**: Encrypts an API key

### Restore API

The Restore API restores application data from backup archives.

#### Endpoints

- **POST /api/restore**: Restores application data from a backup archive

#### Request

The request must be sent as `multipart/form-data` with the following fields:

- `file`: The backup ZIP file
- `selections`: JSON string array of items to restore

#### Restore Process

1. **Validation**: Verifies the backup file and structure
2. **Storage Files**: Restores selected storage files
3. **MCP Servers Folder**: Restores MCP server repositories if selected

### Server-Sent Events (SSE) API

The SSE API provides Server-Sent Events for real-time communication with MCP servers.

#### Endpoints

- **GET /api/sse**: Establishes an SSE connection
- **POST /api/sse**: Sends a message to an MCP server

#### SSE Connection Parameters

- `transportType`: The type of transport (`stdio` or `websocket`)
- `command`: The command to execute for stdio transport
- `args`: Command arguments
- `env`: Environment variables
- `serverName`: Name of an existing MCP server
- `url`: WebSocket URL for websocket transport

#### SSE Events

- `endpoint`: Contains the endpoint URL for sending messages
- JSON-RPC messages from the MCP server
- Error events from stderr

### Storage API

The Storage API manages application storage, providing a simple interface for reading, writing, and deleting data.

#### Endpoints

- **GET /api/storage**: Retrieves data from storage
- **POST /api/storage**: Saves data to storage
- **DELETE /api/storage**: Deletes data from storage

#### Storage Keys

The API only accepts valid storage keys defined in the `StorageKey` enum:

```typescript
enum StorageKey {
  MODELS = 'models',
  MCP_SERVERS = 'mcp_servers',
  FLOWS = 'flows',
  CHAT_HISTORY = 'chat_history',
  THEME = 'theme',
  GLOBAL_ENV_VARS = 'global_env_vars',
  ENCRYPTION_KEY = 'encryption_key'
}
```

## Common Patterns and Best Practices

### Adapter Pattern

Many API modules use the adapter pattern to delegate calls to backend services. This pattern provides several benefits:

- **Decoupling**: Frontend and backend can evolve independently
- **Testability**: Adapters can be mocked for testing
- **Maintainability**: Changes to backend services don't affect the API interface

Example:

```typescript
// API adapter
export const modelAdapter = {
  async listModels() {
    return await modelService.listModels();
  },
  
  async getModel(id: string) {
    return await modelService.getModel(id);
  }
};

// API handler
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const action = searchParams.get('action');
  
  if (action === 'listModels') {
    const models = await modelAdapter.listModels();
    return Response.json({ models });
  }
  
  if (action === 'getModel') {
    const id = searchParams.get('id');
    if (!id) {
      return Response.json({ error: 'Missing model ID' }, { status: 400 });
    }
    
    const model = await modelAdapter.getModel(id);
    return Response.json({ model });
  }
  
  return Response.json({ error: 'Invalid action' }, { status: 400 });
}
```

### Action-Based Routing

Many API endpoints use action-based routing, where a single endpoint handles multiple operations based on an `action` parameter. This approach provides a clean interface while minimizing the number of endpoints.

Example:

```typescript
// GET request with action parameter
// GET /api/model?action=listModels

// POST request with action in body
// POST /api/model
// { "action": "addModel", "model": { ... } }
```

### Frontend Service Integration

API endpoints are designed to be used through frontend services, which provide a clean interface for frontend components.

Example:

```typescript
// Frontend service
export const modelService = {
  async loadModels() {
    const response = await fetch('/api/model?action=listModels');
    const data = await response.json();
    return data.models;
  },
  
  async addModel(model) {
    const response = await fetch('/api/model', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'addModel', model })
    });
    return await response.json();
  }
};

// Frontend component
const models = await modelService.loadModels();
```

## Security Considerations

### Encryption of Sensitive Data

Several API modules implement encryption for sensitive data:

- **Encryption API**: Provides core encryption functionality
- **Environment Variables API**: Automatically encrypts sensitive variables
- **Model API**: Encrypts API keys

### Input Validation

All API endpoints implement thorough input validation to prevent security issues:

- **Parameter Validation**: Ensures required parameters are present and valid
- **Type Checking**: Verifies parameter types
- **Sanitization**: Sanitizes inputs to prevent injection attacks

### Error Handling

API endpoints implement careful error handling to avoid leaking sensitive information:

- **Generic Error Messages**: Avoids exposing internal details
- **Appropriate Status Codes**: Returns correct HTTP status codes
- **Structured Error Responses**: Provides consistent error format

## Error Handling

API endpoints follow a consistent error handling pattern:

### HTTP Status Codes

- **200 OK**: Successful response
- **400 Bad Request**: Missing or invalid parameters
- **404 Not Found**: Resource not found
- **500 Internal Server Error**: Server-side errors

### Error Response Format

```json
{
  "error": "Error message"
}
```

### Success Response Format

```json
{
  "success": true,
  "data": { ... }
}
```

or

```json
{
  "result": "operation-result"
}
```

### Error Logging

All errors are logged with request IDs for traceability, while ensuring sensitive information is not exposed in logs.
