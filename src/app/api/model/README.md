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

### API Routes

- `route.ts`: Implements the HTTP request handlers for the API endpoints
- `provider/route.ts`: Implements provider-specific API endpoints

### Adapters

The API layer uses the adapter pattern to delegate calls to the backend service:

- `model-adapter.ts`: Adapts model-related operations and sanitizes sensitive data
- `provider-adapter.ts`: Adapts provider-related operations

### Backend Services

The backend services handle the core business logic:

- `index.ts`: Main service class that provides methods for model management
- `provider.ts`: Provider-specific logic for fetching models
- `encryption.ts`: Encryption-related logic for API keys

## Flow of Control

1. Frontend components use the frontend service to make API calls
2. Frontend service makes HTTP requests to the API endpoints
3. API routes process the requests and delegate to the appropriate adapter
4. Adapters delegate to the backend service and sanitize sensitive data
5. Backend service performs the operations and returns the raw results
6. Adapters sanitize the results before returning them to the API routes
7. API routes format the results and return them to the frontend

## Separation of Concerns

- **Backend Service**: Focuses purely on business logic and data operations. Returns raw, complete data without any sanitization.
- **Adapter Layer**: Acts as a bridge between API routes and backend services. Handles all data transformations for presentation, including sanitizing sensitive data.
- **API Routes**: Focus on HTTP concerns (status codes, headers, etc.). Delegate to adapters, not directly to services.

## Benefits

- **Clean Architecture**: Clear separation of concerns between layers
- **No Circular Dependencies**: Each layer only depends on the layer below it
- **Maintainability**: Each component has a single responsibility
- **Testability**: Components can be tested in isolation
- **Extensibility**: New features can be added without modifying existing code
- **Security**: Sensitive data is sanitized at the adapter layer before reaching the frontend

## API Endpoints

### GET Endpoints

- `?id={modelId}`: Get a specific model
- `/`: List all models

### POST Endpoints

- `{ action: 'addModel', model }`: Add a new model
- `{ action: 'updateModel', model }`: Update an existing model
- `{ action: 'deleteModel', id }`: Delete a model

### PUT Endpoints

- Update an existing model

### DELETE Endpoints

- `?id={modelId}`: Delete a model

### Provider Endpoints

- `POST /api/model/provider`: Fetch models from a provider

## Usage

The API layer should not be used directly by frontend components. Instead, frontend components should use the frontend service, which will make the appropriate API calls.

```typescript
// Frontend component
import { modelService } from '@/frontend/services/model';

// Call a method on the frontend service
const models = await modelService.loadModels();
```

The frontend service will make an API call to the appropriate endpoint, which will be handled by the API layer and delegated to the backend service through the adapter layer.

## Important Implementation Notes

1. **Sanitization**: The adapter layer is solely responsible for sanitizing sensitive data (like API keys) before it reaches the frontend. The backend service should never perform sanitization.

2. **Consistent Adapter Usage**: All API routes should use the adapter layer consistently, never bypassing it to call the backend service directly.

3. **Internal Backend Usage**: Other backend components that need model data should call the backend service directly to get the raw, unsanitized data they need.
