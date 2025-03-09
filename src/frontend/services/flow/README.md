# Flow Frontend Service

This directory contains the frontend service implementation for the Flow functionality. The frontend service provides a client-side API for UI components to interact with flows.

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

### Frontend Service

The frontend service is responsible for:

- Providing a clean interface for UI components
- Making API calls to the server-side API layer
- Handling errors and providing user feedback
- Caching flow data for improved performance
- Creating and manipulating flow nodes and edges
- Generating sample flows for testing
- Supporting history entries for undo/redo functionality

### Core Components

- `FlowService` class: Main service class that provides methods for flow management
- API integration for flow operations
- Node and edge creation and manipulation
- History entry creation for undo/redo
- Error handling and user feedback

## API Reference

### Flow Management

- `loadFlows()`: Load all flows via API
- `getFlow(flowId)`: Get a specific flow via API
- `saveFlow(flow)`: Save a flow (create new or update existing) via API
- `deleteFlow(flowId)`: Delete a flow via API

### Node and Edge Management

- `createNode(type, position)`: Create a new node of the specified type at the given position (client-side)
- `createNewFlow(name?)`: Create a new flow with a default Start node (client-side)
- `createHistoryEntry(nodes, edges)`: Create a history entry for undo/redo functionality (client-side)
- `generateSampleFlow(name?)`: Generate sample flow data for testing (client-side)

## Usage Examples

```typescript
// Import the service
import { flowService } from '@/frontend/services/flow';

// Load all flows
const flows = await flowService.loadFlows();

// Get a specific flow
const flow = await flowService.getFlow('flow-id');

// Create a new flow
const newFlow = flowService.createNewFlow('My New Flow');

// Save a flow
const saveResult = await flowService.saveFlow(newFlow);

// Delete a flow
const deleteResult = await flowService.deleteFlow('flow-id');

// Create a new node
const node = flowService.createNode('process', { x: 250, y: 150 });

// Create a history entry for undo/redo
const historyEntry = flowService.createHistoryEntry(flow.nodes, flow.edges);

// Generate a sample flow
const sampleFlow = flowService.generateSampleFlow('Sample Flow');
```

## Best Practices

### Flow Management

1. **Caching**: Use the flow cache to improve performance when accessing flows multiple times
2. **Error Handling**: Always handle errors gracefully and provide meaningful error messages to users
3. **Validation**: Validate flow data before saving to ensure integrity
4. **API Integration**: Use the API layer for all server-side operations

### Node and Edge Management

1. **Unique IDs**: Always use unique IDs for nodes and edges to prevent conflicts
2. **Position Management**: Handle node positioning carefully to prevent overlaps
3. **Type Validation**: Validate node types to ensure they are supported
4. **Property Validation**: Validate node properties to ensure they are appropriate for the node type

### History Management

1. **Granular History**: Create history entries for each significant change to support fine-grained undo/redo
2. **Deep Copies**: Always create deep copies of nodes and edges when creating history entries
3. **History Limits**: Consider implementing limits on history size to prevent memory issues

### Error Handling

1. **Detailed Error Messages**: Provide detailed error messages that help users understand and fix issues
2. **Error Context**: Include context in error messages, such as flow ID and operation being performed
3. **User-Friendly Errors**: Convert technical error messages to user-friendly messages
4. **Error Logging**: Log all errors for debugging and troubleshooting

## Implementation Notes

The frontend service makes API calls to the server-side API layer for all operations that require server-side processing, such as loading, saving, and deleting flows. For client-side operations, such as creating nodes and generating sample flows, the service performs these operations locally to improve performance.

The service also implements caching to reduce the number of API calls and improve performance. When a flow is loaded or saved, it is cached in memory for future use. The cache is updated when flows are saved or deleted to ensure consistency.
