# Flow node types

FlowBuilder flows run from one node to the next along their outgoing edges. Use this reference to choose the node type that best fits each step.

| Node type | Purpose | Reference |
|---|---|---|
| Start | Defines where a flow begins. | — |
| Process | Sends conversation context to a model. | — |
| MCP / Resource | Reads a resource exposed by an MCP server. | — |
| Subflow | Runs another flow as a child step. | — |
| Static | Injects authored messages or synthetic tool exchanges into a conversation. | [Static node](./static-node.md) |
| Finish | Ends a flow and returns its result. | — |

More node references will be added here as they become available.
