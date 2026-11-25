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

In the Expert builder you can instead choose **Go on** for a no or a time-out. The
flow then continues, and you add a condition on `${var:review.outcome}` to an
outgoing connection to take a different path, for example "rewrite the draft" after
a no. A flow that uses **Go on** only opens in the Expert builder.

## How to answer

- **In the chat:** a card under the conversation shows the question, the content and
  the questions to fill in, with buttons to accept or turn it down.
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

## Limits

- A run that is not saved cannot wait. This covers flows started as MCP flow tools,
  API runs with `mode: ephemeral`, and Human steps inside a subflow. There the step
  ends at once with a clear message instead of waiting.
- Anyone who can use this FLUJO can answer. Named reviewers are not there yet.

For how it works inside, see [Human step node (design)](../../architecture/human-step-node.md).
