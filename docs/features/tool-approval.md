# Tool approval

## Overview

The **Require tool approvals** checkbox in the chat ("Run options") is the one
approval switch for a conversation. When it is on, every tool call waits for
an Approve or Reject click before it runs. When it is off (the default, and
what older conversations without the setting get), tool calls run right away.

## What the person sees

- **On:** each tool call shows a card with the tool name and its arguments, and
  two buttons: **Approve** runs it, **Reject** does not run it. The AI then gets
  the fixed answer `tool denied`, never a reason.
- **Several calls at once:** each call is decided on its own. The AI continues
  only after every call of that batch has an answer.
- **Off:** no card, no pause.
- **Turning the box off while cards are open** does not run them. They still
  need a click, or the run can be stopped.
- **Changing the box while the agent works** is saved at once and applies from
  the agent's next tool call. Calls already on the card keep waiting.
- **Reloading the page** brings the card back, also while an agent that runs
  its own tools (Claude, Codex, a sub-flow) waits.
- **Saving the setting failed:** the box goes back to the saved setting and the
  chat shows "Could not save "Require tool approvals"…". Nothing else appears
  on success.
- **Keyboard and screen readers:** the card is a region named "Tool approval
  required" whose help line is read out when it appears. Each "Approve" and
  "Reject" button names its tool, and both work with Tab and Enter.

Approval is never remembered for a tool, server, folder or later call.

## Where the setting comes from

The saved setting of the conversation is the only source:

- The chat saves the box when it changes, and sends "on" with a message while
  it is ticked.
- `/v1/chat/completions` takes `metadata.requireApproval` as `"true"` or
  `"false"` (the JSON booleans work too). A value saves that choice for this run
  and the ones after it. **Left out, the conversation's saved setting applies**;
  a new conversation starts with approval off. Any other value is refused with
  `400 invalid_require_approval`. Before #1284 a request that left it out ran
  tools unasked and switched the saved box off.
- A run reads the setting each time it accepts a batch of tool calls, and an
  agent that runs its own tools reads it before each call, so a change saved
  mid-run applies from the next batch. While such a save is still being written,
  the next batch asks.

## One gate for every path (#1284)

Every tool call FLUJO runs for an AI goes through the same gate, whichever way
the call comes in:

| Where the call comes from | How it waits | Where the person answers |
|---|---|---|
| Ordinary AI step (OpenAI, Anthropic, Gemini, Ollama and similar) | The run pauses and is saved | The chat card, `POST /v1/chat/conversations/{id}/respond`, or the approval inbox for automations |
| AI that runs its own tool loop (Claude subscription, Codex, Antigravity) | The run waits live | The same chat card and `/respond` route |
| Sub-flow | The child run waits live, in the conversation the person is viewing | The same chat card |
| A tool called from a code-mode program (`run_tool_script`) or through `call_tool` (#1448) | The program waits live; the card shows the real tool and its arguments | The same chat card and `/respond` route |
| Static node with "wait for a person", Human step | The run pauses and is saved | The chat card, the approval inbox, or `/api/human-tasks`; a Human step also through an MCP task's input form |

The gate code is `src/backend/execution/flow/toolApprovalGate.ts` and runFlow's
pause. The lint rule `flujo/single-tool-approval-gate` fails when other code
reads the setting with another default, adds a new place that answers
approvals, or pauses a run for approval itself.

### When nobody answers

- **A saved pause** (ordinary AI step, automation with `approvalPolicy: pause`)
  waits until someone answers. It holds no model process, survives a restart,
  and shows as "waiting for approval".
- **A live wait** (an AI with its own tool loop, or a sub-flow) holds a model
  process, so it ends after 30 minutes. The tool does not run, the run ends with
  "Nobody answered the approval request for … within 30 minutes, so it did not
  run. Send a message to ask again.", and the conversation is free again. Live
  waits are listed in the approval inbox too (see below).
- **A run that has no conversation to ask in** never runs the tool on its own.
  It ends with an `approval_required` error.

The gate never says yes on its own.

### A restart in the middle

- Calls that wait in a saved pause are still waiting after a restart.
- FLUJO saves an approval before the tool starts: the call leaves the card and
  the saved batch. If FLUJO stopped while an approved tool was running, the call
  is not offered again; the conversation shows the interruption on its error
  line and the AI reads that the tool was interrupted. An attempt that failed
  half way is settled the same way at once, with the result "This approved tool
  call was interrupted … so FLUJO did not run it again".
- This is stored in the shape every FLUJO version reads (the call is no longer
  in the waiting batch), so going back to an older version cannot run such a
  call a second time either. A conversation saved by an older version, where an
  interrupted call still waits, is settled as interrupted on the next Approve.

## Automations and the approval inbox

An automation sets the gate once, when it creates its conversation:
`approvalPolicy: auto` means off, `pause` and `fail` mean on. After that the
conversation's saved setting decides.

| Run | A call that needs approval |
|---|---|
| `approvalPolicy: pause` | Waits in the approval inbox (`GET /api/approvals`) |
| `approvalPolicy: fail` | The run fails with `approval_required`. The tool does not run. |
| Any other run that is not saved | The run fails with `approval_required`. The tool does not run. |

`GET /api/approvals` lists each waiting batch with an `approvalId`. Send the
decision to `POST /api/approvals/{approvalId}` with
`{ "action": "approve" | "deny", "toolCallId"?: "<id>" }`. Without `toolCallId`
every call of that batch that still waits gets the same answer; calls the run
makes after it continues are never included. An `approvalId` belongs to one
batch: once that batch is decided it stops working (`404`), and the next batch
gets a new one. Entries saved before this change keep the conversation id as
their `approvalId` until their batch is decided.

Calls a running agent or sub-flow waits on live are listed as well, one entry
per call with `"live": true`, the conversation, the tool name (never the
arguments) and `expiresAt`, when the wait gives up. `POST` its `approvalId` the
same way: the run goes on at once and the answer is
`{ "status": "running", "live": true }`. The id names that one call and stops
working once the call is answered.

## Approval required by a flow step

The checkbox is a choice for one conversation. A flow author can also state
what must never run unasked, in the Process step:

- `requireApprovalFor`: a list of MCP tool names. Calls to them in this step
  always wait for a person.
- `requireApprovalForWrites`: `true` makes every MCP tool in this step wait
  unless its server marks it read-only (`readOnlyHint: true`). A tool with no
  hint counts as one that can change data. In the step editor this is the
  switch **Ask a person before tools that can change data**.

A step rule can only add to the checkbox. With the checkbox on, every call
still asks. When only some calls of a batch need approval, the others run
first and the run then waits for the rest. The rule uses the same gate as the
checkbox, so it also asks live inside a sub-flow. A tool a server wrongly marks
read-only does not wait, because the hint comes from the server.

## Not part of the approval decision

- Persona Behavior rules (`behaviorRules`): they decide which abilities a
  Persona has, never whether a call may run.
- Saved "always allow" or "always deny" decisions, per-tool `autoApprove`,
  protected-folder rules or default policies by tool, server or path. These
  were removed in commit `9c99e755` (#438) and must not come back.

## Design and tests

- Design: [single-gate proposal](../architecture/tool-approval-single-gate-proposal.md)
- `__tests__/flow/toolApprovalGate.test.ts`: live waits, the 30-minute end, no
  approver means no run.
- `__tests__/chat/respondApprovalGate.test.ts`: missing setting means off on
  resume, restart during a wait, no second run after a crash.
- `__tests__/scheduler/approvalsRoute.test.ts`,
  `__tests__/scheduler/pendingApprovalsStore.test.ts`: batch receipts, old
  receipts after a later batch, an inbox that cannot be read is never emptied.
- `__tests__/flow/stepToolApproval.test.ts`, `__tests__/flow/subflow.test.ts`:
  step rules and sub-flows.
- `__tests__/chat/applyApprovalDecision.test.ts`: the decision is saved before
  the tool starts, in a form a rolled-back version also honours.
- `__tests__/flow/toolApprovalDuringRun.test.ts`: real runs; the saved setting
  when a request says nothing, ticking and unticking mid-run, a sub-flow's wait
  answered from the inbox.
- `__tests__/chat/requireApprovalMetadata.test.ts`: `metadata.requireApproval`.
- `__tests__/chat/conversationPatchStatus.test.ts`: saving the box during a run,
  the card after a reload.
- `__tests__/frontend/components/ToolApprovalCard.test.tsx`: names, arguments,
  the region and its read-out line.
- `npm run journey:tool-approval` (`scripts/tool-approval-journey/run.mjs`): the
  whole thing in a browser on a production build, in the `First-use journey`
  job of `verify-full.yml`.
