# Human step

A Human step stops a flow until a person answers, then lets it go on. Use it when
something should not happen without a person's say: sending an email, paying a
bill, publishing a post, or any answer you want to check first.

While the flow waits, nothing keeps running in the background. The wait is saved,
so it survives a restart of FLUJO.

## The three kinds of Human step

| Kind | What the person does | What the next step gets |
|---|---|---|
| **Approve** | Says yes or no. | Whether it was approved. |
| **Fill in** | Answers a few questions (short or long text, a number, yes or no, pick one, pick several). | The answers, one per question. |
| **Review and edit** | Sees a result, can change it, then sends it on or turns it down. | The changed text (the original is kept too). |

## Example: draft, check, send

1. **AI step:** "Write a reply to this customer."
2. **Human step (Review and edit):** "Check the reply before it goes out." The person
   sees the AI's draft, fixes a word or two and accepts it.
3. **AI step:** "Send this reply: `${var:review.value}`." It sends the text the person
   accepted, not the first draft.
4. **Finish.**

If the person says no, the flow stops with a short message and nothing is sent.

## Add a Human step

**Simple builder (Easy view):** choose **Add human step** under your steps. The step
is added at the end, before the final answer, and its settings open at once. It
starts as **Approve** with a ready-made question you can change.

**Expert builder (canvas):** pick **Ask a person** in the node list, connect it
between two steps, then open its settings (double-click the node, or select it and
choose **Full settings**).

In the settings you choose:

- **What should the person do?** Approve, Fill in, or Review and edit.
- **Title** and **Question for the person.** The question can use `${var:NAME}`.
- **What to show:** the latest answer from the AI (the usual choice) or a saved
  result from earlier in the run. For Review and edit you can say the content is
  JSON; then an edited value must still be valid JSON.
- **Questions to fill in** (Fill in only): add, remove and reorder questions. Each
  one has an answer name, an answer type, whether it must be answered, choices for
  the pick types, and a lowest and highest value for numbers.
- **Result name:** where the answer is saved (`review` unless you change it). Later
  steps read it with `${var:review.value}`, and `${var:review.outcome}` says what
  happened (`approved`, `rejected`, `submitted`, `declined` or `timed_out`).
- **Wait up to:** how long the step waits. The default is 7 days; you can choose from
  1 minute to 365 days.

**Save** stays off, with a short note, until the step can run, for example while the
question is empty.

## Deadline, and what a no does

When the wait time runs out, the step counts as **timed out**. A time-out never
counts as a yes.

By default a no or a time-out **stops the run** with a message. You can write your
own message for each, or keep the default ("Not approved." and "Nobody answered in
time.").

In the Expert builder a no or a time-out can lead somewhere else instead:

- **Draw it.** The step has a red **No** handle on its left and an orange **Timed out**
  handle on its right. Connect one to the step that should come next, for example
  "rewrite the draft" after a no. That connection is taken for that answer, instead
  of stopping. The handle at the bottom is the path after a yes.
- **Or choose Go on** for a no or a time-out. The flow then continues on its plain
  connections, and you can add a condition on `${var:review.outcome}` to one of them.

A flow that uses either of these only opens in the Expert builder.

## How to answer

- **In the chat:** a card under the conversation shows the question, the content and
  the questions to fill in, with buttons to accept or turn it down. It works at phone
  width too. If a sub-flow asked, the card shows in the chat you started.
- **From another app, a script or a phone:** `GET /api/human-tasks` lists waiting
  steps. `GET /api/human-tasks/{requestId}` shows one step, with a `digest` of what
  the person sees. Answer with `POST /api/human-tasks/{requestId}`:

  ```json
  { "action": "approve", "digest": "<digest from the GET>" }
  ```

  Use `submit` with `"value": { ... }` for Fill in, or with the changed text for
  Review and edit. `reject` or `decline` turns it down and needs no digest. The
  digest makes sure a yes only counts for exactly what the person saw: if the
  content changed in the meantime, the answer is refused. Sending the same answer
  twice is safe; you get the first receipt back.
- **Scheduled runs:** a step in a scheduled run waits in the same approval inbox as
  other approvals.
- **From an MCP client:** a flow you call as an MCP tool runs saved when it may ask a
  person. An MCP client that uses Tasks sees the task waiting for input, with a form
  for the step; its answer goes to the step, and the task then gets the flow's result,
  even after a restart of FLUJO. Any other MCP call gets a short note right away: the
  flow waits for a person, in which conversation, and how to answer. The flow goes
  on by itself once someone answers.
- **A Persona's step** is answered the same way, but only from this computer.

## Where a Human step can wait

Everywhere a flow runs: a chat, an automation, an MCP client, FLUJO's own
`execute_flow` tool, a Persona, and inside a sub-flow. A flow that may ask a person is
always saved, so its wait survives a restart; FLUJO saves such a run even when it
would otherwise not keep it (a sub-flow set not to keep its conversation, or a flow
called as an MCP tool).

- **Inside a sub-flow:** the step waits in the sub-flow's own conversation, and the
  flow that called it waits too. Other sub-flows of the same step finish meanwhile.
  Once the person answers, both go on, and nothing that ran before the step runs
  again. Stopping the outer flow, or sending it a new message, ends the sub-flow's
  step as well.
- **A sub-flow that an AI step calls as a tool** cannot make that AI step wait. The AI
  is told that the sub-flow waits for a person; the sub-flow goes on by itself once
  answered. A Persona behavior that an AI step calls as a tool runs only for that call,
  so a Human step there ends the call with a clear message instead of waiting.
- Anyone who can use this FLUJO can answer.

For how it works inside, see [Human step node (design)](../../architecture/human-step-node.md).
