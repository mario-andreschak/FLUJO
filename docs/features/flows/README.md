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

## A step can only use the tools it offers

A Process step offers the model the tools of its connected apps, its routes to other steps, and any built-in tools switched on for that step. FLUJO checks that same list again when the model calls a tool. A call to anything else returns an error to the model and does not run, including a tool that an earlier step of the same run was allowed to use.

Once a step has offered tools, later steps of the conversation also offer `read_resource` and `list_mcp_resources`, so they can read results the run has already produced. These two tools are part of the offered list and can be called.
