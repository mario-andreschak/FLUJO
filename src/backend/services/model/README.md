# Model Backend Service

This directory contains the backend service implementation for the Model service. The backend service is part of a clean architecture pattern that separates concerns between UI components, frontend services, API layer, and backend services.

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

## Components

The backend service is organized into modular components:

- `index.ts`: Main service class that provides methods for model management
- `provider.ts`: Provider-specific logic for fetching models from different AI providers
- `encryption.ts`: Encryption-related logic for secure API key handling

## Responsibilities

The backend service is responsible for:

- **Data Management**: Handling model data persistence and retrieval
- **Business Logic**: Implementing core business logic for model operations
- **Security**: Managing encryption and secure handling of API keys
- **Provider Integration**: Interfacing with various AI model providers
- **Error Handling**: Providing comprehensive error handling and logging

## Key Features

### Model Management

- Loading, saving, and retrieving models
- Adding, updating, and deleting models
- Validating model data for integrity

### Provider Integration

- Supporting multiple AI providers (OpenAI, Anthropic, Mistral, etc.)
- Fetching available models from providers
- Normalizing provider-specific data

### Security

- Encrypting and decrypting API keys
- Supporting global variable references for API keys
- Managing encryption configuration

### Completion Generation

- Generating completions using configured models
- Handling provider-specific API requests
- Error handling and response normalization

## API Reference

### Model Management

- `loadModels()`: Load all models from storage
- `getModel(modelId)`: Get a specific model by ID
- `addModel(model)`: Add a new model
- `updateModel(model)`: Update an existing model
- `deleteModel(id)`: Delete a model by ID
- `listModels()`: List all models with standardized response

### Provider Integration

- `fetchProviderModels(baseUrl, modelId?)`: Fetch models from a provider

### Security

- `encryptApiKey(apiKey)`: Encrypt an API key
- `decryptApiKey(encryptedApiKey)`: Decrypt an API key
- `resolveAndDecryptApiKey(encryptedApiKey)`: Resolve and decrypt an API key
- `isEncryptionConfigured()`: Check if encryption is configured
- `isUserEncryptionEnabled()`: Check if user encryption is enabled
- `setEncryptionKey(key)`: Set the encryption key
- `initializeDefaultEncryption()`: Initialize default encryption

### Completion Generation

- `generateCompletion(modelId, prompt, messages)`: Generate a completion using a model

## Usage Examples

```typescript
// Import the service
import { modelService } from '@/backend/services/model';

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
  'https://api.openai.com/v1',
  'model-id'
);

// Generate a completion
const completion = await modelService.generateCompletion(
  'model-id',
  'Generate a response to this prompt',
  [{ role: 'user', content: 'Hello, world!' }]
);
```

## Benefits of This Architecture

- **Separation of Concerns**: Each component has a specific responsibility
- **Modularity**: Components can be developed and tested independently
- **Testability**: Business logic is isolated and can be tested without UI dependencies
- **Maintainability**: Changes to one component don't affect others
- **Security**: Sensitive operations are handled in the backend
