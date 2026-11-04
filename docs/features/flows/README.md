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

## Check a message before any model sees it

Open an edge that leaves a Start or a Static node and turn on **Conditional edge**. The flow takes the first edge whose condition matches. An edge without a condition is the fallback. If nothing matches and there is no fallback, the run ends without calling a model.

To answer certain questions with a fixed text, connect Start to a Static node that holds the text, put the condition on that edge, and connect Start to your Process step with a plain edge. A matching message never reaches the model.

| Edge leaves | Message tested by default |
|---|---|
| Start | The last user message |
| Static | The last message, which is this node's own result if it produced one |
| Process | The step's last reply |

A flow with a condition before its first Process step goes back to Start on every user turn, including follow-ups, edited messages and retries. This restarts the flow at its first step each turn, so use it for flows where that is what you want.

Keep these limits in mind:

- A condition reads the text of one message. It does not read attached files, and it does not understand meaning, so a reworded question can pass a word list.
- An earlier message stays in the conversation history. If a question was blocked, a later "answer my last question" passes the check and the model can still see the old text. Set the Process step to receive only the latest message if the model must never see earlier turns.
- A regular expression that does not compile never matches. The flow check warns about this. If a blocking condition relies on such a pattern, messages take the fallback route.

## A step can only use the tools it offers

A Process step offers the model the tools of its connected apps, its routes to other steps, and any built-in tools switched on for that step. FLUJO checks that same list again when the model calls a tool. A call to anything else returns an error to the model and does not run, including a tool that an earlier step of the same run was allowed to use.

Once a step has offered tools, later steps of the conversation also offer `read_resource` and `list_mcp_resources`, so they can read results the run has already produced. These two tools are part of the offered list and can be called. `read_resource` can be called in any step, because FLUJO can offer it at the last moment when a conversation refers to a stored result.
