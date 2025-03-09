# Model Frontend Service

This directory contains the frontend service implementation for the Model service. The frontend service is part of a clean architecture pattern that separates concerns between UI components, frontend services, API layer, and backend services.

## Architecture

The Model implementation follows a clean architecture pattern:

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│                 │     │                 │     │                 │
│  UI Components  │◄───►│  Frontend       │◄───►│  API Layer      │◄───┐
│  (ModelManager) │     │  Service        │     │  (Adapters)     │    │
└─────────────────┘     └─────────────────┘     └─────────────────┘    │
                                                        │               │
                                                        ▼               │
                                                ┌─────────────────┐     │
                                                │                 │     │
                                                │  Backend        │◄────┘
                                                │  Service        │
                                                └─────────────────┘
```

## Responsibilities

The frontend service is responsible for:

- **UI Integration**: Providing a clean API for UI components
- **API Communication**: Making API calls to the server-side API layer
- **Caching**: Managing client-side caching for performance
- **Error Handling**: Providing user-friendly error handling
- **Data Transformation**: Transforming data for UI consumption

## Key Features

### Model Management

- Loading, retrieving, and caching models
- Adding, updating, and deleting models
- Validating model data before submission

### Provider Integration

- Fetching available models from providers
- Displaying provider-specific information

### Security

- Handling API key encryption through API calls
- Masking sensitive information for UI display
- Supporting global variable references

### Completion Generation

- Generating completions using configured models
- Error handling and user feedback

## API Reference

### Model Management

- `loadModels()`: Load all models
- `getModel(modelId)`: Get a specific model by ID
- `addModel(model)`: Add a new model
- `updateModel(model)`: Update an existing model
- `deleteModel(id)`: Delete a model by ID

### Provider Integration

- `fetchProviderModels(baseUrl, modelId?)`: Fetch models from a provider

### Security

- `encryptApiKey(apiKey)`: Encrypt an API key
- `decryptApiKey(encryptedApiKey)`: Decrypt an API key for UI display
- `isEncryptionConfigured()`: Check if encryption is configured
- `isUserEncryptionEnabled()`: Check if user encryption is enabled
- `setEncryptionKey(key)`: Set the encryption key

### Completion Generation

- `generateCompletion(modelId, prompt, messages)`: Generate a completion using a model

## Usage Examples

```typescript
// Import the service
import { modelService } from '@/frontend/services/model';

// Load all models
const models = await modelService.loadModels();

// Get a specific model
const model = await modelService.getModel('model-id');

// Add a new model
const result = await modelService.addModel({
  id: 'new-model-id',
  name: 'gpt-4',
  displayName: 'GPT-4',
  encryptedApiKey: 'encrypted-api-key',
  baseUrl: 'https://api.openai.com/v1'
});

// Fetch models from a provider
const providerModels = await modelService.fetchProviderModels(
  'https://api.openai.com/v1'
);

// Generate a completion
try {
  const completion = await modelService.generateCompletion(
    'model-id',
    'Generate a response to this prompt',
    [{ role: 'user', content: 'Hello, world!' }]
  );
  console.log(completion);
} catch (error) {
  console.error('Error generating completion:', error);
}
```

## Implementation Details

### API Communication

The frontend service communicates with the backend through the API layer:

```typescript
// Example API call
const response = await fetch('/api/model?action=listModels');
const data = await response.json();
```

### Caching Strategy

The service implements a simple caching strategy:

- Cache models after initial load
- Update cache when models are added, updated, or deleted
- Use cache first, then fallback to API calls

### Error Handling

The service provides user-friendly error handling:

- Catch and log errors
- Return meaningful error messages
- Format errors for UI consumption

### Security Considerations

The service follows security best practices:

- Never expose decrypted API keys in the UI
- Mask sensitive information with asterisks
- Support global variable references for shared API keys

## Benefits of This Architecture

- **Separation of Concerns**: UI components only need to know about the frontend service
- **Abstraction**: The frontend service abstracts away API details
- **Consistency**: Provides a consistent interface for UI components
- **Maintainability**: Changes to the API layer don't affect UI components
- **Testability**: The frontend service can be tested independently
