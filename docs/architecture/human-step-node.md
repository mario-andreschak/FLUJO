# Human step node

Status: first slice built (issue [#1095](https://github.com/mario-andreschak/FLUJO/issues/1095)).

A **Human step** stops a flow until a person answers, then goes on. It can ask
for a yes or no (**approval**), for a few typed answers (**input**), or show a
result the person can change before it is used (**edit**). Example:
Draft → Human step (edit) → Send → Finish.

## What other tools do

| Tool | How it waits | What we take from it |
|---|---|---|
| LangGraph `interrupt()` | Saves a checkpoint; a later `Command(resume=…)` with the interrupt id continues. The node runs again from its start, so work before the interrupt must be safe to repeat. | Answer a specific wait by its id. Never redo the work before the wait. |
| Temporal signals and updates | The workflow sleeps on a durable timer; an update is checked before it is accepted, and duplicates are dropped by id. | Check an answer before saving it; the same answer twice returns the first receipt; the deadline is stored, not a live timer. |
| n8n Wait node | The run is saved to the database and resumed by a webhook or form, with an optional time limit. | Nothing stays in memory while waiting. A time limit has an explicit outcome. |
| MCP elicitation and Tasks | A task moves to `input_required` with flat form questions; `accept`, `decline` and `cancel` are separate answers. | Keep decline, time-out and cancel apart from approve. Flat typed fields only. |

## How FLUJO does it

FLUJO already saves a run that waits for a tool approval and continues it after
a restart, and the Static node's `humanGate` entry already uses that path for a
plain yes or no. The Human step uses it too, so it shows up wherever a waiting
approval shows up today: the chat, the scheduled-run inbox and the existing
answer endpoints.

1. **Waiting.** When a run reaches the step, the node freezes what the person
   will see: the question, the result to review, the form fields. It stores this
   as `SharedState.humanTask` with a new `requestId` and a **digest** (SHA-256 of
   exactly that content), adds one synthetic `human_step` call as the pending
   item, and returns the approval action. The run is saved with status
   `awaiting_tool_approval` and stops. No worker, slot, request or promise is
   held while it waits.
2. **Answering.** An answer names the `requestId` (through its call id) and, to
   accept, repeats the digest the person saw. The server recomputes the digest
   from the saved request. A different digest is refused (409), so an old "yes"
   can never unlock a newer draft. Declining needs no digest, because it is
   always safe. Typed fields are checked on the server; a bad answer is refused
   (422) and the step keeps waiting. The decision is saved before the answer is
   acknowledged. Sending the same answer again returns the saved receipt;
   a different answer after a decision is refused (409).
3. **An edit is a new version.** The original stays in the request. The answer
   is stored with its own digest, and the step writes a result to its output
   variable:
   `{ requestId, decisionId, outcome, value, candidateDigest, valueDigest, edited }`.
   A later step reads the value with `${var:review.value}` and can use
   `${var:review.decisionId}` as an idempotency key for a send, so a retried send
   is recognisable. The variable is marked as written by a person, so a decision
   rule or edge condition can insist on that.
4. **Continuing.** The run continues from the same step with the same logical run;
   nothing before the step runs again. Approved or submitted continues to the next
   step. Rejected, declined or timed out stops the run with a short message,
   unless the author chose `continue`, in which case the flow can route on
   `review.outcome`.
5. **Expiry.** The deadline is fixed once, when the wait starts
   (`expiresAt`; default 7 days, the author can choose 1 minute to 1 year).
   An answer after the deadline is refused (410). A sweep runs every minute and
   once at start-up. It records `timed_out` for overdue steps and continues the
   run on its time-out choice. Time-out never approves. The sweep also restarts
   any run whose decision was saved but not yet continued (for example after a
   crash), so a saved decision is never lost.
6. **Inbox.** `db/human_tasks.json` lists waiting steps with ids, flow, step
   title, mode and times only, never the content. The conversation state is the
   source of truth; the list repairs itself from it and forgets finished entries
   after 7 days. The sweep at start-up opens every waiting step once, because
   FLUJO may have stopped between saving an answer and updating the list.
7. **Ending without an answer.** A new chat message replaces a waiting step, as
   it does a Static wait. Cancelling the run drops the step and any saved answer
   that was not used, so neither a late answer nor the deadline can bring the run
   back.

## Where an answer comes from

| Surface | How |
|---|---|
| Chat | A card under the conversation shows the question, the content and the form, and sends the answer through `POST /v1/chat/conversations/{id}/respond` with a `human` payload. |
| Any client, phone or script | `GET /api/human-tasks` lists waiting steps, `GET /api/human-tasks/{requestId}` shows one with its digest, `POST /api/human-tasks/{requestId}` answers it and returns a receipt at once while the run continues in the background. |
| Scheduled runs | They wait in the same approval inbox as before (`needs_approval`). `POST /api/approvals/{id}` also accepts a `human` payload. |

All answer routes keep the existing checks: the workspace must be unlocked,
requests must come from this machine, and a Persona run continues only through
its dispatcher with fresh authority.

## Builders

- **Visual builder:** a **Human step** node in the palette with its own
  properties dialog (mode, question, what to review, fields, output variable,
  deadline, what a no or a time-out does).
- **Simple builder:** a step can be a Human step (`{ "id": "review", "human": { … } }`
  in SimpleFlowSpec). The guided composer has an **Add human step** button.
  Simple flows stay a straight line: approve or submit goes on, anything else stops.
- **FlowSpec:** `type: "human"` round-trips through the compiler.

## Not in this slice

- **Runs that are not saved** (MCP flow tools, `mode: ephemeral` API runs,
  subflows) cannot come back to a wait. A Human step there fails at once with
  `approval_required` and a plain message instead of pretending to finish.
- **MCP Tasks `input_required`.** The Tasks extension can ask the MCP client for
  form input, and `serverTasks.ts` already supports it for a live task. Using it
  for a Human step would keep the flow run and its run slot busy until someone
  answers, and the task fails when FLUJO restarts. Both break the rules above
  (release everything while waiting, survive a restart). It needs flow runs
  started over MCP to be saved first, so a task can point at a saved wait
  (#1095, slice 4).
- **Persona runs through the new API.** `POST /api/human-tasks/{id}` refuses a
  Persona's step (409, `persona_owned`), because only the Persona dispatcher may
  continue those runs. The chat card falls back to the chat answer route, which
  goes through the dispatcher.
- **Outcome handles on the canvas.** Routing on the answer uses ordinary edge
  conditions on `review.outcome`; there are no separate "yes" and "no" handles.
- **Who may answer** is the owner of this FLUJO, as for approvals today. Named
  reviewers come later.
