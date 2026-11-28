# Human step node

Status: built for every place a flow runs (issue [#1095](https://github.com/mario-andreschak/FLUJO/issues/1095)).

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
| Chat | A card under the conversation shows the question, the content and the form. It answers through `POST /api/human-tasks/{requestId}`, the same address as any other client. |
| Any client, phone or script | `GET /api/human-tasks` lists waiting steps, `GET /api/human-tasks/{requestId}` shows one with its digest, `POST /api/human-tasks/{requestId}` answers it and returns a receipt at once while the run continues in the background. |
| Chat answer route and approval inbox | `POST /v1/chat/conversations/{id}/respond` and `POST /api/approvals/{id}` accept a `human` payload, as before. Scheduled runs wait in the approval inbox (`needs_approval`). |
| MCP Tasks | A flow tool whose run waits is `input_required` with one form per step; `tasks/update` answers it (see below). |

Every surface ends in one function, `answerHumanTask`
(`src/backend/services/humanTasks/answerHumanTask.ts`): it finds the run that asked,
checks the answer and saves it. The routes keep their checks: the workspace must be
unlocked and requests must come from this machine.

## Sub-flows

A child flow with a Human step (or with a sub-flow of its own that has one) always
runs saved, even when its Subflow step is set not to keep the child's conversation,
because only a saved run can stop and come back. (`subflowHumanWait.ts` decides this
from the child flow with `flowMayWaitForPerson`, the same check automations, MCP
flow tools and `execute_flow` use.) A run that is not saved at all and whose sub-flow
waits ends with a clear message and ends the child's step, instead of leaving it to
wait for nothing.

1. **The child stops.** The child saves its wait like any run. The Subflow step marks
   that child's lane `waiting`, with the child's request ids. Other lanes run to their
   end; the step does not join yet.
2. **The parent stops too.** The Subflow step shows each waiting child's call as its
   own pending call and returns the approval action, so runFlow saves the parent and
   stops it. Neither run holds a worker. The step list entry names the child as the
   owner and the parent as `parentConversationId`.
3. **Answering.** The card in the parent's chat, the API, the chat answer route and
   the approval inbox all send the answer to the child that asked (the parent only
   shows the call). The answer is saved on the child.
4. **Going on.** FLUJO finds the top run that waits through its sub-flows and
   continues that one. Its Subflow step looks at each waiting child again: a child
   that still only waits is asked again, a child with an answer is continued from
   where it stopped (it gets no new input, and nothing it did before runs again), and
   a finished child's answer is taken. The step joins once nobody waits. A child that
   was stopped or failed while it waited is never started again; its lane fails.
   Nested sub-flows work the same way, one level at a time.
5. **Ending without an answer.** The child's own deadline times it out and the
   parent goes on with the child's time-out answer. A new message in the parent, or
   cancelling the parent, ends the child's waiting step too
   (`dropHumanTask.ts`), so a late answer finds nothing to continue.

A sub-flow called as a tool from inside an AI step cannot make that step wait; the
tool result then says that the sub-flow waits for a person and goes on by itself
once answered.

## Runs that used to be unsaved

Flow tools over MCP and FLUJO's own `execute_flow` tool used to run unsaved, so a
Human step there could only fail. Now a flow that may wait for a person (a Human
step or a step approval, `flowRequiresStepApproval`) runs saved, like automations
already did. When it stops, the caller gets a clear hand-over instead of an empty
success: the text and `structuredContent` say that the flow waits for a person, in
which conversation, and how to answer it (`waiting_for_person`, the conversation id
and the step ids). The run then goes on in FLUJO once someone answers. The MCP
call's own authority is taken off the saved run when it hands over: it goes on under
FLUJO's authority, like any answered run.

## MCP Tasks

A task-augmented flow tool call whose run stops at a Human step hands the task over
to the saved run (`ServerTaskHandoff`). From then on the task has no process behind
it; `serverTasks.ts` reads it from the run through `flowToolContinuations.ts`:

| The run | The task |
|---|---|
| waits at Human steps (its own or its sub-flows') | `input_required`, with one `elicitation/create` form per step, keyed `human:<requestId>`. The form is built from the frozen step: approval is one yes/no field, an edit is one text field with the draft as its default, typed questions map to flat fields (text, number, yes/no, one choice, several choices). |
| goes on after an answer | `working` |
| finishes | `completed`, with the final answer as the tool result, sealed once |
| fails or is stopped | `failed` |

`tasks/update` answers a step through `answerHumanTask` (channel `mcp`). The form
showed exactly the frozen step, so the answer is bound to that step's digest. An
answer that does not fit is refused (`TASK_INPUT_INVALID`) and the task keeps
asking. The same key again after the answer was used is acknowledged and changes
nothing; a different answer is refused. The step can still be answered in FLUJO; the
task simply follows the run. `tasks/cancel` stops the run and ends its steps; it never
counts as an answer.

Because nothing lives in memory, a restart changes nothing: the task is still
`input_required` with the same forms, and its result arrives once the run finishes.
While a task follows a run it holds no execution slot. Its handle is kept for the
longest time the protocol allows (24 hours, never past the caller's sign-in). That
is a different clock from the step's own deadline: when the handle expires the task
fails with `TASK_EXPIRED`, but the run keeps waiting in FLUJO and can still be
answered there. An expired handle never counts as an answer.

## Persona runs

A Persona's step is answered at the same address. A Persona's run may only change
with its dispatcher's authority, so the answer is first checked on a copy, then the
dispatcher takes the run and records and uses the answer inside its preparation,
with fresh authority. The reply comes once the dispatcher has taken it (200 with the
receipt). As for every Persona control, the answer must come from this computer
itself (403 otherwise). A Persona's sub-flow child goes on the same way, through the
parent's dispatcher.

## Routing on the answer

The canvas node has three outgoing handles: the bottom one (yes, or a submitted
answer), a red **No** handle on the left and an orange **Timed out** handle on the
right. A connection from the No or Timed out handle is saved with
`data.humanOutcome` (`rejected` or `timed_out`) and is taken for that answer, in
place of stopping. A connection without one is the plain path: taken after a yes, and
after a no or a time-out only when the author chose **Go on**. Conditions on
`${var:review.outcome}` still work among the plain connections. FlowSpec carries the
answer as `humanOutcome` on an edge, and the simple builder sends such a flow to the
Expert view, because it is no longer a straight line.

## Builders

- **Visual builder:** a **Human step** node in the palette with its own
  properties dialog (mode, question, what to review, fields, output variable,
  deadline, what a no or a time-out does) and the three handles above.
- **Simple builder:** a step can be a Human step (`{ "id": "review", "human": { … } }`
  in SimpleFlowSpec). The guided composer has an **Add human step** button.
  Simple flows stay a straight line: approve or submit goes on, anything else stops.
- **FlowSpec:** `type: "human"` round-trips through the compiler, and so does an
  edge's `humanOutcome`.

## Who may answer

Anyone who may use this FLUJO, as for tool approvals (the contract's
`reviewer: { kind: 'owner' }`). With sign-in for several people on, the workspace
routes already check who is signed in. A Persona's step additionally needs a request
from this computer.

## How it is checked

- `__tests__/flow/humanStep.test.ts`: the node, digest refusal, idempotent retries,
  restart, the deadline sweep and the scheduled inbox, through runFlow.
- `__tests__/flow/humanStepWaits.test.ts`: sub-flows (wait, restart, join, deadline,
  parallel lanes, a crash after the answer, a new message), MCP flow tools and MCP
  Tasks (form, restart, `tasks/update`, refusal, answer in FLUJO, cancel), routing on
  the No connection and its FlowSpec round trip, and a Persona answer through its
  dispatcher, all through runFlow and saved state.
- `__tests__/api/humanTasksRoute.test.ts`: the answer API.
- `scripts/human-step-journey/run.mjs` (`npm run journey:human-step`): a browser
  check on a throwaway FLUJO with a local stand-in model: Easy view, Expert canvas,
  Draft → Review and edit → Send in the chat, and a Fill-in step at phone width with a
  wrong answer first and the conversation opened again afterwards.
