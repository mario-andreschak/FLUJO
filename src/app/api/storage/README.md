# Storage API

This directory contains the API endpoint for managing application storage, providing a simple interface for reading, writing, and deleting data.

## Architecture

The Storage API follows a simple architecture:

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│                 │     │                 │     │                 │
│  Frontend       │◄───►│  API Layer      │◄───►│  Storage        │
│  Components     │     │  (route.ts)     │     │  Utilities      │
└─────────────────┘     └─────────────────┘     └─────────────────┘
```

## Components

### API Handler

- `route.ts`: Handles HTTP requests for storage operations, including:
  - GET: Retrieve stored data
  - POST: Save data
  - DELETE: Remove data

### Integration with Other Services

- **Storage Utilities**: Uses backend storage utilities to persist data to the filesystem

## Flow of Control

1. Frontend components make API calls to get, save, or delete data
2. API handler validates the request parameters
3. API handler delegates to the appropriate storage utility function
4. Results are returned to the frontend

## API Endpoints

### GET /api/storage

Retrieves data from storage.

#### Query Parameters

- `key` (required): The storage key to retrieve (must be a valid `StorageKey` enum value)
- `defaultValue` (optional): JSON string of the default value to return if the key doesn't exist

#### Response

```json
{
  "value": "stored data"
}
```

### POST /api/storage

Saves data to storage.

#### Request Body

```json
{
  "key": "storage_key",
  "value": "data to store"
}
```

The `key` must be a valid `StorageKey` enum value.

#### Response

```json
{
  "success": true
}
```

### DELETE /api/storage

Deletes data from storage.

#### Query Parameters

- `key` (required): The storage key to delete (must be a valid `StorageKey` enum value)

#### Response

```json
{
  "success": true
}
```

## Storage Keys

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

## Error Handling

The API returns appropriate HTTP status codes and error messages:

- `400 Bad Request`: Invalid or missing storage key
- `500 Internal Server Error`: Server-side errors

Error responses include a descriptive message:

```json
{
  "error": "Error message"
}
```

## Usage Examples

### Retrieve Data

```typescript
// Get data with a specific key
const response = await fetch('/api/storage?key=models');
const data = await response.json();

if (data.value) {
  console.log('Retrieved models:', data.value);
} else {
  console.error('Error:', data.error);
}

// Get data with a default value
const defaultValue = JSON.stringify([]);
const response = await fetch(`/api/storage?key=models&defaultValue=${encodeURIComponent(defaultValue)}`);
const data = await response.json();

console.log('Retrieved models (with default):', data.value);
```

### Save Data

```typescript
// Save data
const response = await fetch('/api/storage', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    key: 'models',
    value: [
      { id: '1', name: 'Model 1' },
      { id: '2', name: 'Model 2' }
    ]
  })
});

const data = await response.json();
if (data.success) {
  console.log('Data saved successfully');
} else {
  console.error('Error saving data:', data.error);
}
```

### Delete Data

```typescript
// Delete data
const response = await fetch('/api/storage?key=models', {
  method: 'DELETE'
});

const data = await response.json();
if (data.success) {
  console.log('Data deleted successfully');
} else {
  console.error('Error deleting data:', data.error);
}
```

## Security Considerations

### Data Validation

The API implements several measures to ensure data integrity:

1. **Key Validation**: Only accepts predefined storage keys from the `StorageKey` enum
2. **Error Handling**: Properly handles and reports errors without exposing sensitive information
3. **Logging**: Logs all operations with request IDs for traceability

### Sensitive Data

When working with sensitive data:

1. **Encryption**: The API does not handle encryption directly; sensitive data should be encrypted before storage
2. **Access Control**: The API does not implement access control; it's assumed to be used in a trusted environment
