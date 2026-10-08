# Flow node types

FlowBuilder flows follow execution edges between steps. App and resource connections supply tools or data to those steps. Use this reference to choose the node type that best fits each purpose.

| Node type | Purpose | Reference |
|---|---|---|
| Start | Defines where a flow begins. | — |
| Process | Sends conversation context to a model. | — |
| MCP | Connects an MCP server's tools to an AI step. | [Connected apps](../mcp/overview.md) |
| Resource | Shares a temporary result within a run or reads a resource exposed by an MCP server. | — |
| Subflow | Runs another flow as a child step. | — |
| Static | Injects authored messages or synthetic tool exchanges into a conversation. | [Static node](./static-node.md) |
| Finish | Ends a flow and returns its result. | — |
| Signal | Emits a notification that can activate another automation. | — |
| Trigger | Starts a flow on a configured schedule or event. | [Running agents](running-flows.md) |

More node references will be added here as they become available.
