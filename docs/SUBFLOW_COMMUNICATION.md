# Communication between parent and child agents

A running agent can send instructions to its child agents, and a child can send progress, questions, or replies to its parent. The communication tools are available automatically to orchestrators and subflows. No experimental setting or communication flag is required.

Configure a Subflow node with the child flow and connect it to the calling process. The model receives `call_subflow_*`, `start_subflow_*`, and graph handoff tools for that target. There is no invocation-mode toggle to set, and older experimental switches are ignored. The suffix comes from the target's name; use the actual tool name offered to the model.

## Choose how the parent waits

A direct Subflow node, a synchronous handoff, and `call_subflow_*` wait for the child to return. The child can queue a message for the parent, but the parent cannot answer while it is waiting inside that synchronous call. Discovery and send receipts report `replyAvailability: "after_child_returns"`; trying to wait for that parent returns an explanation instead of deadlocking.

For an ongoing exchange, use `start_subflow_*`. It starts the child in the background and immediately returns a task handle with `taskId`, `childConversationId`, and `parentConversationId`. The parent can keep working, send a follow-up instruction, and use `subflow_wait` to wait for a reply. If the parent tries to finish while its background children are still working, FLUJO keeps it available and brings their next message or result back to the model automatically. This avoids needing a special orchestration prompt just to receive replies.

## Tools

| Tool | Arguments | Purpose |
| --- | --- | --- |
| `call_subflow_*` | `task`: task text | Run a configured child inline and return its result. |
| `start_subflow_*` | `task`: task text; required when the target requires an explicit task | Start a configured child in the background. |
| `subflow_list` | `{}` | Discover the current parent and children, their conversation IDs, task IDs where available, and status. |
| `subflow_send_message` | `target`, `message` | Queue an instruction, progress update, question, or reply. `message` must be nonempty and at most 32,000 characters. |
| `subflow_wait` | Optional `target`, optional `timeoutMs` | Wait for incoming input or a selected child's terminal status. The default wait is 30,000 ms; the supported range is 0–60,000 ms. |
| `subflow_task_get` | `taskId` | Read a background task's status and terminal result. |
| `subflow_task_cancel` | `taskId` | Cancel a background task. |

For `subflow_send_message` and `subflow_wait`, `target` is `"parent"`, a child conversation ID, or a child task ID returned by the tools. Recipients must belong to the caller's parent–child family in the same workspace. Omitting `target` from `subflow_wait` watches incoming messages and child status; `timeoutMs: 0` checks without waiting.

## Example exchange

1. The parent calls its offered `start_subflow_research` tool with `{"task":"Check the migration and report any blockers."}` and keeps the returned child ID.
2. The parent calls `subflow_send_message` with `{"target":"<childConversationId>","message":"Also check whether existing workspaces need a backup."}`.
3. The child calls `subflow_send_message` with `{"target":"parent","message":"The migration needs a backup. Should I also check rollback instructions?"}`.
4. The parent uses `subflow_wait`, reads the child's message on its next model turn, and sends its answer to the same child.
5. The child finishes. Its completion notice is queued for an active parent; the parent can also inspect the task with `subflow_task_get` before writing its final answer.

## Delivery and conversation display

A successful send returns `status: "queued"` and `delivery: "next_safe_boundary"`. This means the runtime accepted the message for the next safe model boundary. It does **not** mean the recipient has already read or answered it. A paused recipient must resume before it can process the message. `subflow_wait` reports incoming input without consuming it; the execution loop adds it to the conversation after the tool returns.

Agent messages are shown as **Message from _sender_**, and completion notices as **Result from _sender_**, in both the normal chat and the expanded conversation-chain preview. The sender's conversation ID is used if no name is available. Nested subflow and lane attribution remain visible. Model input also contains a textual sender header, so the delivery is not presented as a new instruction from the human user.

Sending to a completed, failed, cancelled, or unavailable recipient returns an error. A message does not silently restart a terminal parent or child. A wait timeout is also not a reply: continue independent work, wait again, or inspect the task status. Task records are persisted; queued steering input is handled by the active runtime, so a queue receipt is not a guarantee of delivery after the process exits.

See [Flows](features/flows/README.md) for creating and running a flow.
