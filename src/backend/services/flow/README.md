# Flow Backend Service

This directory contains the backend service implementation for the Flow functionality. The backend service is responsible for managing flow data and providing core flow manipulation operations.

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

### Backend Service

The backend service is responsible for:

- Managing flow data persistence
- Caching flows for improved performance
- Creating and manipulating flow nodes and edges
- Generating sample flows for testing
- Supporting history entries for undo/redo functionality

### Core Components

- `FlowService` class: Main service class that provides methods for flow management
- Flow storage and retrieval
- Node and edge creation and manipulation
- History entry creation for undo/redo
- Error handling and logging

## API Reference

### Flow Management

- `loadFlows()`: Load all flows from storage
- `getFlow(flowId)`: Get a specific flow by ID
- `saveFlow(flow)`: Save a flow (create new or update existing)
- `deleteFlow(flowId)`: Delete a flow by ID
- `listFlows()`: List all flows with standardized response format

### Node and Edge Management

- `createNode(type, position)`: Create a new node of the specified type at the given position
- `createNewFlow(name?)`: Create a new flow with a default Start node
- `createHistoryEntry(nodes, edges)`: Create a history entry for undo/redo functionality
- `generateSampleFlow(name?)`: Generate sample flow data for testing

## Flow Structure

Flows are structured as follows:

```typescript
interface Flow {
  id: string;           // Unique identifier for the flow
  name: string;         // Human-readable name
  nodes: FlowNode[];    // Array of nodes in the flow
  edges: Edge[];        // Array of edges connecting nodes
}

interface FlowNode {
  id: string;           // Unique identifier for the node
  type: string;         // Node type (e.g., 'start', 'process', 'finish', 'mcp')
  position: {           // Position of the node in the flow
    x: number;
    y: number;
  };
  data: {               // Node data
    label: string;      // Display label
    type: string;       // Node type (redundant with the top-level type)
    properties: any;    // Node-specific properties
  };
}
```

## Node Types

The Flow Service supports several node types:

1. **Start Node**: Entry point for the flow
   - Properties: promptTemplate, systemMessage, temperature

2. **Process Node**: Intermediate processing step
   - Properties: operation, enabled

3. **Finish Node**: Exit point for the flow
   - Properties: format, template

4. **MCP Node**: Integration with Model Context Protocol
   - Properties: channels, mode

## Usage Examples

```typescript
// Import the service
import { flowService } from '@/backend/services/flow';

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
4. **Backup**: Consider implementing flow backup functionality to prevent data loss

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
3. **User-Friendly Errors**: Convert technical error messages to user-friendly messages in the frontend
4. **Error Logging**: Log all errors for debugging and troubleshooting
