# Flow API Layer

This directory contains the API layer for the Flow service implementation. The API layer serves as an interface between the frontend and backend services.

## Architecture

The Flow implementation follows a clean architecture pattern with clear separation of concerns:

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│                 │     │                 │     │                 │
│  UI Components  │◄───►│  Frontend       │◄───►│  API Layer      │◄───┐
│  (FlowManager)  │     │  Service        │     │  (Adapters)     │    │
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

- `flow-adapter.ts`: Adapts flow-related operations

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

- `?action=listFlows`: List all flows
- `?action=getFlow&id={flowId}`: Get a specific flow

### POST Endpoints

- `{ action: 'addFlow', flow }`: Add a new flow
- `{ action: 'updateFlow', flow }`: Update an existing flow
- `{ action: 'deleteFlow', id }`: Delete a flow
- `{ action: 'createNewFlow', name }`: Create a new flow with default nodes
- `{ action: 'generateSampleFlow', name }`: Generate a sample flow for testing

## Usage

The API layer should not be used directly by frontend components. Instead, frontend components should use the frontend service, which will make the appropriate API calls.

```typescript
// Frontend component
import { flowService } from '@/frontend/services/flow';

// Call a method on the frontend service
const flows = await flowService.loadFlows();
```

The frontend service will make an API call to the appropriate endpoint, which will be handled by the API layer and delegated to the backend service.
