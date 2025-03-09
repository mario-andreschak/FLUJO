# Model API Layer

This directory contains the API layer for the Model service implementation. The API layer serves as an interface between the frontend and backend services.

## Architecture

The Model implementation follows a clean architecture pattern with clear separation of concerns:

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

### API Handlers

- `handlers.ts`: Contains the HTTP request handlers for the API endpoints
- `route.ts`: Exports the handlers and initializes the backend service

### Adapters

The API layer uses the adapter pattern to delegate calls to the backend service:

- `model-adapter.ts`: Adapts model-related operations
- `provider-adapter.ts`: Adapts provider-related operations

### Backend Services

The backend services handle the core business logic:

- `index.ts`: Main service class that provides methods for model management
- `provider.ts`: Provider-specific logic for fetching models
- `encryption.ts`: Encryption-related logic for API keys

## Flow of Control

1. Frontend components use the frontend service to make API calls
2. Frontend service makes HTTP requests to the API endpoints
3. API handlers process the requests and delegate to the adapters
4. Adapters delegate to the backend service
5. Backend service performs the operations and returns the results
6. API handlers format the results and return them to the frontend

## Benefits

- **Clean Architecture**: Clear separation of concerns between layers
- **No Circular Dependencies**: Each layer only depends on the layer below it
- **Maintainability**: Each component has a single responsibility
- **Testability**: Components can be tested in isolation
- **Extensibility**: New features can be added without modifying existing code

## API Endpoints

### GET Endpoints

- `?action=fetchModels&baseUrl={baseUrl}&modelId={modelId}`: Fetch models from a provider
- `?action=fetchOpenRouterModels`: Fetch models from OpenRouter (legacy endpoint)
- `?action=listModels`: List all models
- `?action=getModel&id={modelId}`: Get a specific model
- `?action=checkEncryption`: Check encryption status

### POST Endpoints

- `{ action: 'generateCompletion', modelId, prompt, messages }`: Generate a completion
- `{ action: 'addModel', model }`: Add a new model
- `{ action: 'updateModel', model }`: Update an existing model
- `{ action: 'deleteModel', id }`: Delete a model
- `{ action: 'setEncryptionKey', key }`: Set encryption key
- `{ action: 'encryptApiKey', apiKey }`: Encrypt an API key

## Usage

The API layer should not be used directly by frontend components. Instead, frontend components should use the frontend service, which will make the appropriate API calls.

```typescript
// Frontend component
import { modelService } from '@/frontend/services/model';

// Call a method on the frontend service
const models = await modelService.loadModels();
```

The frontend service will make an API call to the appropriate endpoint, which will be handled by the API layer and delegated to the backend service.
