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

### API Routes

- `route.ts`: Collection endpoints — list all flows (`GET`) and create a flow (`POST`)
- `[id]/route.ts`: Single-resource endpoints — get (`GET`), create-or-replace (`PUT`), delete (`DELETE`) a flow by ID
- `prompt-renderer/route.ts`: Renders a node's prompt within a flow (`POST`)
- `_helpers.ts`: Shared `json()` response builder (not a route — the leading `_` keeps Next.js from treating it as one)

The routes call the backend `flowService` (`@/backend/services/flow`) directly; the
flow service performs no sanitization, so no adapter layer sits in between.

## Flow of Control

1. Frontend components use the frontend service to make API calls
2. Frontend service makes HTTP requests to the API endpoints
3. API routes process the requests and delegate to the backend service
4. Backend service performs the operations and returns the results
5. API routes format the results and return them to the frontend

## Benefits

- **Clean Architecture**: Clear separation of concerns between layers
- **No Circular Dependencies**: Each layer only depends on the layer below it
- **Maintainability**: Each component has a single responsibility
- **Testability**: Components can be tested in isolation
- **Extensibility**: New features can be added without modifying existing code

## API Endpoints

The flow API follows standard REST resource conventions:

| Method | Path | Description | Success |
|--------|------|-------------|---------|
| `GET` | `/api/flow` | List all flows | `200` + `Flow[]` |
| `POST` | `/api/flow` | Create a flow (body = `Flow`; rejects a duplicate id) | `201` + `Flow` |
| `GET` | `/api/flow/{id}` | Get a single flow | `200` + `Flow` |
| `PUT` | `/api/flow/{id}` | Update a flow (body = `Flow`; path `{id}` is authoritative) | `200` + `Flow` |
| `DELETE` | `/api/flow/{id}` | Delete a flow | `204` (no body) |
| `POST` | `/api/flow/prompt-renderer` | Render a node's prompt within a flow | `200` + `{ prompt }` |

Errors return `{ "error": string }` with an appropriate status (`400` invalid input,
`404` not found, `409` duplicate on create, `500` server error).

Create and update are separate, mirroring the Model API: `POST` creates and fails if
the id already exists; `PUT` updates an existing flow and returns `404` if it does not.
The frontend mints a new flow's id client-side, so the UI knows whether a save is a
create or an update and calls `addFlow` (`POST`) or `updateFlow` (`PUT`) accordingly.

## Usage

The API layer should not be used directly by frontend components. Instead, frontend components should use the frontend service, which will make the appropriate API calls.

```typescript
// Frontend component
import { flowService } from '@/frontend/services/flow';

// Call a method on the frontend service
const flows = await flowService.loadFlows();
```

The frontend service will make an API call to the appropriate endpoint, which will be handled by the API layer and delegated to the backend service.
