# Environment Variables API

This directory contains the API layer for managing environment variables with secure encryption support.

## Architecture

The Environment Variables API follows a clean architecture pattern with integration to the encryption system:

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│                 │     │                 │     │                 │
│  Frontend       │◄───►│  API Layer      │◄───►│  Storage        │
│  Components     │     │  (route.ts)     │     │  Utilities      │
└─────────────────┘     └─────────────────┘     └─────────────────┘
                               │
                               ▼
                        ┌─────────────────┐
                        │                 │
                        │  Encryption     │
                        │  Utilities      │
                        └─────────────────┘
```

## Components

### API Handler

- `route.ts`: Handles HTTP requests for environment variable operations, including:
  - Getting environment variables (with optional decryption)
  - Setting environment variables (with automatic encryption for sensitive data)
  - Deleting environment variables

### Integration with Other Services

- **Storage Utilities**: Uses backend storage utilities to persist environment variables
- **Encryption Utilities**: Automatically encrypts sensitive environment variables

## Flow of Control

1. Frontend components make API calls to get, set, or delete environment variables
2. API handler processes the request and determines if encryption is needed
3. For sensitive variables (like API keys), the API automatically encrypts the values
4. For retrieval, the API decrypts sensitive values if requested
5. Results are returned to the frontend

## Security Features

### Automatic Encryption of Sensitive Data

The API automatically detects and encrypts sensitive environment variables:

1. Variables with names containing "key", "secret", "password", "token", or "auth" are considered sensitive
2. Sensitive variables are encrypted before storage
3. Encrypted values are stored with an `encrypted:` prefix
4. Failed encryptions are marked with an `encrypted_failed:` prefix

### Secure Retrieval

When retrieving environment variables:

1. By default, sensitive variables are returned as `********` placeholders
2. Only when explicitly requested with `includeSecrets=true` are the actual values decrypted and returned
3. This prevents accidental exposure of sensitive data in logs or UI

## API Endpoints

### GET /api/env

Retrieves environment variables.

#### Query Parameters

- `key` (optional): Retrieve a specific environment variable
- `includeSecrets` (optional): Set to `true` to include decrypted sensitive values

#### Response (All Variables)

```json
{
  "variables": {
    "PUBLIC_VAR": "public value",
    "API_KEY": "********" // Placeholder for sensitive data
  }
}
```

#### Response (Single Variable)

```json
{
  "value": "variable value"
}
```

### POST /api/env

Sets or deletes environment variables.

#### Set a Single Variable

```json
{
  "action": "set",
  "key": "VARIABLE_NAME",
  "value": "variable value"
}
```

#### Set Multiple Variables

```json
{
  "action": "setAll",
  "variables": {
    "VAR1": "value1",
    "VAR2": "value2",
    "API_KEY": "sensitive value" // Will be automatically encrypted
  }
}
```

#### Delete a Variable

```json
{
  "action": "delete",
  "key": "VARIABLE_NAME"
}
```

#### Response

```json
{
  "success": true
}
```

## Error Handling

The API returns appropriate HTTP status codes and error messages:

- `400 Bad Request`: Missing or invalid parameters
- `500 Internal Server Error`: Server-side errors

Error responses include a descriptive message:

```json
{
  "error": "Error message"
}
```

## Usage Examples

### Get All Environment Variables

```typescript
// Get all environment variables (sensitive values masked)
const response = await fetch('/api/env');
const data = await response.json();

console.log('Environment variables:', data.variables);

// Get all environment variables including sensitive values
const responseWithSecrets = await fetch('/api/env?includeSecrets=true');
const dataWithSecrets = await responseWithSecrets.json();

console.log('Environment variables with secrets:', dataWithSecrets.variables);
```

### Get a Specific Environment Variable

```typescript
// Get a specific environment variable
const response = await fetch('/api/env?key=API_URL');
const data = await response.json();

console.log('API URL:', data.value);

// Get a sensitive environment variable with its actual value
const responseWithSecret = await fetch('/api/env?key=API_KEY&includeSecrets=true');
const dataWithSecret = await responseWithSecret.json();

console.log('API Key:', dataWithSecret.value);
```

### Set Environment Variables

```typescript
// Set a single environment variable
await fetch('/api/env', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    action: 'set',
    key: 'API_URL',
    value: 'https://api.example.com'
  })
});

// Set multiple environment variables
await fetch('/api/env', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    action: 'setAll',
    variables: {
      'API_URL': 'https://api.example.com',
      'API_KEY': 'secret-api-key', // Will be automatically encrypted
      'DEBUG': 'true'
    }
  })
});
```

### Delete an Environment Variable

```typescript
// Delete an environment variable
await fetch('/api/env', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    action: 'delete',
    key: 'DEBUG'
  })
});
```

## Security Considerations

### Sensitive Data Protection

The API implements several measures to protect sensitive data:

1. **Automatic Detection**: Identifies sensitive variables based on naming patterns
2. **Transparent Encryption**: Encrypts sensitive values without requiring explicit action
3. **Masked Display**: By default, returns placeholders instead of actual sensitive values
4. **Secure Storage**: Uses the application's encryption system for storing sensitive data

### Error Handling

Error messages are carefully crafted to avoid leaking sensitive information:

1. Generic error messages for encryption failures
2. No inclusion of actual sensitive values in error responses
3. Detailed logging for debugging while keeping sensitive data protected
