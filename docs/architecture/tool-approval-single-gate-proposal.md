# Single-gate tool approval proposal

Status: Design accepted for implementation planning under user-delegated judgment; runtime acceptance pending

Design issue: [#469](https://github.com/mario-andreschak/FLUJO/issues/469)

Removal history: [#438](https://github.com/mario-andreschak/FLUJO/issues/438)

Reviewed code baseline: `adfd3ea80d0e7c4a604992e1450bad414a271896` on `main` (October 24, 2026)

Original plan baseline: `b9379f7522232c52a26cae119bdb164d6dbe15aa`

Decision record: [user direction and delegated design responsibility](https://github.com/mario-andreschak/FLUJO/issues/469#issuecomment-6387339110)

## Purpose and scope

This proposal defines one predictable approval model for ordinary tool calls. It is a
design and requirements artifact only. Issue #469 must not change production
behavior. Runtime changes and tests belong in a separate implementation issue
created from the decision record below. The user's explicit delegation supersedes
the former five-role sign-off process; it does not establish runtime test success.

The design preserves the conversation-level **Require Tool Approval** checkbox as
the only user approval gate. It distinguishes that choice from runtime bookkeeping,
capability composition, and the operational outcome selected by a headless caller
that has no approver.

The product constraints are reliability, compatibility and a quiet interface.
Reuse the existing checkbox, per-call actions and error/status surfaces. Add no
approval settings, policy editor, onboarding, persistent banners or routine success
notifications. Show an actionable error only when a save or operation actually
fails; accessibility status announcements must not add visible clutter.

## Minimal user model

1. The checkbox is stored per conversation.
2. Off, or missing for an older conversation, means ordinary tool calls execute
   without an approval pause.
3. On means every applicable ordinary tool call pauses before execution. The user
   approves or rejects each call independently.
4. Approval is not remembered for a tool, server, resource, folder, path, or later
   call.
5. A rejected call is never invoked. The model receives exactly `tool denied`.
6. Pending calls already shown to a user stay pending until explicitly decided or
   the run is cancelled. Changing the checkbox never silently executes them.
7. Internal registries and Persona/Enduring-Agent capability snapshots are not
   additional approval gates.

"Applicable ordinary tool call" excludes internal handoff control calls. Handoff
ordering is an execution concern and must not create approval cards or bypass the
gate for ordinary calls in the same assistant batch.

## Current-state inventory

The source-level walkthrough was repeated at the reviewed baseline. No tests were
run as part of this design phase.

| Concern | Current location | Classification | Finding |
| --- | --- | --- | --- |
| Checkbox and local state | `src/frontend/components/Chat/ChatInput.tsx`, `src/frontend/components/Chat/index.tsx` | User gate | Conversation-scoped UI, hydrated with a false fallback; failed saves only log and leave optimistic state |
| Persistence client | `src/frontend/services/chat/index.ts` | User gate | PATCHes `requireApproval` |
| Conversation GET/PATCH | `src/app/v1/chat/conversations/[conversationId]/route.ts` | User gate | Missing reads as false; writes require a boolean |
| Runtime normalization and dispatch | `src/backend/execution/flow/runFlow.ts` | User gate | `input.requireApproval ?? false` captured at run entry; later-batch setting refresh is not established |
| Pending call state | `pendingToolCalls`, `awaiting_tool_approval` | Runtime approval state | Describes undecided calls; does not decide permission |
| Approval registry | `src/backend/execution/flow/toolApprovalRegistry.ts` | Runtime coordination | Live SDK callbacks are process-local; restart recovery cannot rely on this registry alone |
| Decision application | `src/backend/execution/flow/resumeAfterApproval.ts` | Runtime approval state | Decides one call, emits `tool denied` on rejection, resumes after drain |
| Chat respond resume | `src/app/v1/chat/conversations/[conversationId]/respond/route.ts` | Boundary | Two false-default violations currently use `?? true` |
| Approval API resume | `src/app/api/approvals/[id]/route.ts` | Boundary | Two false-default violations use `?? true`; omission of toolCallId explicitly resolves all pending calls |
| Conversation execution lock | `src/backend/execution/flow/conversationExecutionLock.ts` | Runtime coordination | Both durable decision routes serialize and re-read state; process-local serialization is not durable exactly-once execution |
| Scheduler policy mapping | `src/backend/services/scheduler/index.ts` | Headless transport behavior | Maps an explicit scheduler setting into gate and no-approver outcome |
| Persona dispatcher | `src/backend/services/enduringAgents/personaDispatcher.ts` | Headless transport behavior | Explicitly supplies requireApproval=false/onApprovalRequired=fail; gate-off ignores the no-approver outcome |
| Claude adapter | `src/backend/services/model/adapters/claudeSubscriptionAdapter.ts` | Provider boundary | Explicit default permission mode, PreToolUse authority checks and human-decision callback; retain execution and capability fences |
| `Flow.behaviorRules` / `SharedState.behaviorRules` | `src/backend/execution/flow/nodes/ProcessNode.ts` | Capability snapshot | Filters Persona-native capabilities; must never approve, deny, or bypass ordinary calls |
| Removed allow/deny/ask and protected-path mechanisms | #438, commit `9c99e755` | Obsolete policy | Must not be reintroduced |

Existing regression intent is captured by:

- `__tests__/flow/toolApprovalSingleGate.test.ts`
- `__tests__/flow/requireApprovalDefault.test.ts`
- `__tests__/chat/applyApprovalDecision.test.ts`
- `__tests__/chat/headlessApproval.test.ts`
- `__tests__/scheduler/approvalPolicy.test.ts`
- `__tests__/scheduler/approvalsRoute.test.ts`

This inventory is not proof of coverage. In particular, requireApprovalDefault
largely asserts local literals; the follow-up must exercise production routes and
runtime entry points for absent/false/true settings.

Intervening flow work stages mixed handoff/tool batches, excludes handoff calls from
ordinary approval, preserves unanswered-call detection, and applies a repeat guard
on resume. The implementation must preserve those behaviors.

## Implementation decisions

These decisions define the follow-up requirements under the user's delegation.
They are not a claim that the current runtime already implements the contract.

| Topic | Decision | Rationale |
| --- | --- | --- |
| Default | Missing `requireApproval` is false at every boundary, including all resume routes | Older records remain compatible and the checkbox remains opt-in |
| No approver | With gate on, fail terminates without execution; pause and runtime auto persist a pause. Gate off ignores this outcome | No silent approval or hidden second policy |
| Mid-flight toggle | A run snapshots the value when it accepts a model-produced ordinary-call batch. Changes affect only later batches | Prevents a UI race from changing the meaning of already-rendered decisions |
| Already-pending calls | They require decisions under the snapshot that created them, or explicit cancellation | Disabling the checkbox cannot silently execute visible pending calls |
| Batch semantics | Decide calls individually and resume model execution only after the ordinary-call batch drains | Gives every call an explicit outcome while maintaining assistant-batch integrity |
| Mixed handoff/tool batches | Handoff calls are not approval subjects; staged ordering and unanswered-call handling remain intact | Approval must not expose internal control calls or reorder execution |
| Rejection | Fixed model-visible `tool denied`; no free-text reason | Deterministic and minimizes sensitive disclosure |
| Persistence failure | Do not present an unpersisted final checkbox state; restore the persisted state and show an actionable error | UI and server state must converge |
| Snapshot boundary | Preserve `behaviorRules` as backend-only capability snapshot data; accept legacy `permissionRules` only while reading old records | This vocabulary remains separate from the approval gate |
| Alternate providers | All providers enter shared approval handling with identical semantics | Provider choice must not weaken or strengthen the gate |
| Arguments | Show enough context for a decision, but do not add argument copies to telemetry, issue comments, or model rejection output | Supports informed decisions without widening data exposure |
| Compatibility | Preserve existing explicit bulk decisions, scheduler settings and owner/capability checks; bind each decision to the displayed batch | Reliability includes existing callers |
| UI | Reuse current controls and error surfaces; no extra settings, panels or routine notices | Quiet operation is an explicit user requirement |

## State contract

| State | Meaning | Permitted exits |
| --- | --- | --- |
| `running` | Model or non-gated execution is in progress | awaiting approval, completed, cancelled, errored |
| `awaiting_tool_approval` | At least one applicable call is pending and no pending call may execute without its decision | awaiting approval, running, cancelled, errored |
| `resumed` | All calls in the pending batch have outcomes and execution is being continued | running, awaiting approval, completed, cancelled, errored |
| `cancelled` | The run was explicitly stopped; pending decisions are invalid | terminal |
| `errored` | Execution ended unsuccessfully, including explicit fail-fast when no approver is attached | terminal |
| `completed` | Execution ended successfully | terminal |

`resumed` is a logical transition and need not become a newly persisted public
status if the implementation can preserve the same observable contract atomically.

### Core sequences

Unchecked or missing:

```mermaid
sequenceDiagram
  participant C as Client
  participant R as Runtime
  participant T as Tool
  C->>R: Run (requireApproval absent/false)
  R->>T: Execute ordinary call
  T-->>R: Tool result
  R-->>C: Continue/complete
```

Checked and approved:

```mermaid
sequenceDiagram
  participant C as Client
  participant R as Runtime
  participant A as Approver
  participant T as Tool
  C->>R: Run (requireApproval=true)
  R-->>A: awaiting_tool_approval + pending call
  A->>R: Approve call ID
  R->>T: Execute exactly that call
  T-->>R: Tool result
  R-->>C: Continue after batch drains
```

Checked and rejected:

```mermaid
sequenceDiagram
  participant R as Runtime
  participant A as Approver
  participant M as Model
  R-->>A: Pending call
  A->>R: Reject call ID
  Note over R: Tool is not invoked
  R->>M: tool result "tool denied"
```

Multiple calls:

```mermaid
sequenceDiagram
  participant A as Approver
  participant R as Runtime
  participant T as Tool
  R-->>A: Calls A, B, C pending
  A->>R: Approve B
  R->>T: Execute B
  R-->>A: A and C still pending
  A->>R: Reject A
  R-->>A: C still pending
  A->>R: Approve C
  R->>T: Execute C
  Note over R: Resume model only after A, B, C have outcomes
```

### Recovery, cancellation, and failure rules

- A pending decision is bound to conversation, run, assistant batch, and tool-call
  identifiers. The server verifies ownership before applying it.
- The first accepted decision for a call is final. An identical retry returns the
  already-applied outcome or a documented no-op response. Existing stale-request
  404 behavior may remain for compatibility; it must never execute again.
  A contradictory retry returns a conflict and never invokes a tool.
- Unknown, stale, cancelled, completed, or mismatched identifiers return a
  non-sensitive not-found or conflict response.
- Restart recovery reloads the persisted pending batch and preserves all recorded
  outcomes. It must not execute undecided calls or re-execute decided calls.
- Persist the decision and execution claim before invocation. A crash after an
  external effect but before recording its result is an uncertain outcome, not
  permission to retry. Surface that interruption through the existing run-error
  surface and require reconciliation before another invocation. Use stable
  downstream idempotency keys where supported; do not promise exactly-once
  external effects for arbitrary tools.
- A live SDK callback lost at restart must be safely reconstructed from durable
  state or surfaced as interrupted. It must never be silently approved.
- Cancellation atomically invalidates remaining pending calls.
- A tool failure becomes that approved call's tool outcome and does not convert any
  undecided sibling into an approval.
- The repeat guard, staged handoff state, and unanswered-call detection survive
  restart and partial decisions.

## API and persistence contract

### Conversation setting

```ts
type ConversationApprovalSettings = {
  requireApproval?: boolean; // missing is read as false
};
```

- GET responses expose an effective boolean.
- PATCH accepts only a JSON boolean and rejects other types.
- A successful PATCH is the persistence boundary for later batches.
- Serialize setting revisions and batch snapshot creation. Late responses and
  failed saves must not overwrite a newer choice or another conversation's UI.
- Before the first conversation is persisted, carry the chosen boolean in the
  initial run request and persist it with that conversation. Do not treat this
  initialization as a failed save on an existing conversation.
- Existing conversations need no migration because a missing value means false.
- Every runtime, debug, resume, scheduler, API, and provider adapter normalizes with
  `value ?? false`; truthiness coercion is forbidden.

### Pending calls

A pending-call representation must contain an opaque decision identifier, stable
tool-call identifier, tool identity, decision-safe argument context, conversation
and run association, and current decision state. Raw secrets must not be added
solely for approval display.

Approval endpoints must:

1. authenticate the caller;
2. authorize access to the owning conversation/run;
3. atomically claim the undecided call;
4. validate that the run and batch are still pending;
5. execute only when the explicit decision is approve;
6. record the deterministic outcome;
7. resume only when the ordinary-call batch is drained; and
8. re-register a later batch if the continued model response pauses again.

Clients opt in only through `requireApproval=true`. They observe
`awaiting_tool_approval` and `pendingToolCalls`, submit one decision per call,
and treat fail-fast as a terminal, machine-readable approval-required error rather
than a denial policy.

For the existing approval inbox API, preserve omission of `toolCallId` as an
explicit decision for all calls in that pending batch. Capture the call IDs under
the decision lock and apply an outcome to each; never include calls generated by
the continuation. Do not add a new bulk UI or require an incompatible request body.
Make the opaque approval receipt identify one batch, retire it on drain/cancel,
and issue a fresh receipt for a later batch. Existing conversation-ID receipts
must be migrated as aliases for their current pending batch only and never reused
for another batch. Tests must cover retrying the old receipt after continuation.

## No-approver behavior

When the gate is false, `onApprovalRequired` is ignored.

When the gate is true:

- an interactive entry point pauses and publishes pending calls;
- a headless entry point configured to `pause` persists a resumable pending run;
- a headless entry point configured to `fail` executes no tool and returns a
  machine-readable terminal error; and
- runtime `auto` pauses, just like `pause`.

These values never auto-approve or reject a call and therefore are transport/runtime
outcomes, not a second authorization source.

Preserve the scheduler's existing auto/fail/pause configuration. When creating a
new scheduled conversation, that explicit configuration initializes the one gate
to false/true/true respectively. Once the conversation exists, its persisted
boolean is authoritative on resume; the scheduler option cannot override it.
Missing legacy conversation values still default to false. No new scheduler
control or background approval requirement is introduced.

## Workflow review record

This table records the source-level engineering walkthrough and intended user
journeys. The decision record below delegates the design judgment; runtime and
accessibility acceptance must still be demonstrated in the implementation issue.

| ID | Actor and initial setting | Expected transitions and visible result | Pain point / security expectation | Proposed acceptance |
| --- | --- | --- | --- | --- |
| W1 | Chat user; on | running → awaiting → resumed | Every ordinary call is visible before execution | Per-call approve/reject |
| W2 | Chat user; off or missing | running → completed/error | No unexpected pause | Default false everywhere |
| W3 | User switches conversations | Each view hydrates its stored value | No setting leakage | Scope strictly per conversation |
| W4 | User; on; multiple calls | Await until all calls have outcomes | Partial decisions must not lose/reorder calls | Individual decisions, batch drain before resume |
| W5 | User rejects | Tool never runs; model sees `tool denied` | No sensitive or free-text feedback | Fixed rejection result |
| W6 | User toggles during run/pause | Current batch keeps snapshot; future batch uses successful persisted value | No silent execution race | Batch-bound semantics |
| W7 | User refreshes/retries/cancels | Persisted pending state recovers or becomes stale/cancelled | No duplicate execution | Atomic idempotent decisions |
| W8 | API client; on | Observe pending status, decide by opaque ID, resume | Ownership and machine-readable errors | Same gate and state contract |
| W9 | Scheduler/headless; on | Explicit pause or fail-fast; execute nothing undecided | No deadlock or hidden decision | Operational no-approver outcome |
| W10 | Alternate-provider user | Same transitions as W1/W2 | Provider cannot bypass gate | Shared contract tests |
| W11 | Persona/Enduring Agent | Capability snapshot selects available tools; gate still handles emitted ordinary calls | Capability composition is not authorization | Snapshot cannot approve/deny/bypass |

## Normative requirements and traceability

| ID | Requirement | Workflows | Future verification |
| --- | --- | --- | --- |
| R1 | `requireApproval` MUST be boolean when supplied and MUST default to false when absent at every boundary | W1–W3, W8–W10 | Route/runtime/provider absent-false-true matrix |
| R2 | The persisted conversation value MUST be the sole user approval-policy source | W1–W3, W11 | Search/static regression plus behavior tests |
| R3 | With the gate on, an ordinary call MUST NOT execute before explicit approval | W1, W4, W8–W10 | Execution spy before/after decision |
| R4 | With the gate off, hidden tool/server/path/saved/flow defaults MUST NOT pause, deny, or auto-approve calls | W2, W11 | Negative policy-layer tests |
| R5 | Rejection MUST NOT invoke the tool and MUST yield exactly `tool denied` without a free-text reason | W5 | Decision-handler assertion |
| R6 | Pending decisions MUST bind to conversation, run, batch, and call and MUST reject unauthorized, stale, duplicate-conflicting, or cancelled decisions | W7, W8 | Ownership/idempotency/recovery suite |
| R7 | Each multi-call batch MUST support partial approval/rejection and MUST resume model execution only after all ordinary calls have outcomes | W4 | Mixed-decision ordering suite |
| R8 | Checkbox changes MUST affect only later batches after successful persistence and MUST NOT release already-pending calls | W6 | Mid-flight and PATCH-failure suite |
| R9 | No-approver behavior MUST be explicit and MUST NOT act as an independent allow/deny policy | W9 | Scheduler/headless pause/fail/auto tests |
| R10 | Alternate providers MUST obey the same gate semantics | W10 | Shared adapter contract tests |
| R11 | Capability snapshot fields MUST NOT authorize, deny, auto-approve, or bypass ordinary tool execution | W11 | Persona capability/gate separation tests |
| R12 | Existing approval UI MUST expose tool identity and decision-safe argument context and support labels, focus, keyboard operation, status announcement, and distinguishable actions, without new settings, panels, persistent banners or routine success notices | W1, W4, W7 | Component and accessibility tests |
| R13 | Sensitive arguments MUST NOT be newly copied into logs, analytics, issue comments, or rejection feedback | W1, W5, W8 | Logging/telemetry security review |
| R14 | Mixed handoff/tool execution MUST preserve staged handoff ordering, unanswered-call detection, and repeat-guard state while excluding handoffs from approval prompts | W4, W7 | Mixed-batch and resume regressions |
| R15 | UI and persisted state MUST converge; a failed setting PATCH MUST restore the persisted value and display an actionable error | W3, W6 | Client failure/component test |

## Future implementation scope

Required corrections are expected in:

- `src/app/v1/chat/conversations/[conversationId]/respond/route.ts`
- `src/app/api/approvals/[id]/route.ts`
- approval persistence and UI error handling where current behavior does not meet R15
- shared runtime/resume/API/provider code where R6–R10 are not already guaranteed
- the tests listed in the inventory and any focused UI/provider/recovery tests needed
  for the matrix above

The implementation issue must first verify every current site because line numbers
and call structure may change. It must separate required contract fixes from the
legacy `permissionRules` compatibility window. It must include rollback for the
implementation commits and durable state changes; default-false records need no backfill.
It must not introduce another authorization-policy layer.

Preserve owner authentication, workspace isolation, capability availability and
execution/cancellation fences. These determine which operations exist and remain
valid; they are not remembered approval preferences. This work requires no team
accounts or deferred #212/#1233 implementation. Human-input nodes tracked in #1095
are separate workflow behavior, not a replacement tool-approval policy.

## Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Resume fallback unexpectedly turns the gate on | Normalize absent state to false and test every resume route |
| Toggle race releases displayed calls | Bind gate state to batch creation and require explicit outcomes |
| Duplicate/replayed approval invokes twice | Atomic decision claim and stable idempotency behavior |
| Restart loses partial outcomes | Persist batch identity and individual decisions |
| Headless run hangs or silently executes | Explicit pause/fail-fast contract with machine-readable state |
| Provider or Persona path bypasses the gate | Shared contract tests and capability/authorization separation |
| Approval display leaks secrets | Decision-safe rendering and no new telemetry copies |
| Flow changes reorder mixed batches | Preserve staged handoff and repeat-guard regressions |

## Decision record and implementation handoff

On October 24, 2026, the user explicitly delegated design judgment to the agent
and required a good user experience, no application breakage and no UI noise.
The [recorded direction](https://github.com/mario-andreschak/FLUJO/issues/469#issuecomment-6387339110)
supersedes the five-role approval procedure; no independent stakeholder reviews
are claimed. The [engineering review](https://github.com/mario-andreschak/FLUJO/issues/469#issuecomment-6387306310)
provides source evidence and concrete scenarios. Its suggestion to reject omitted
toolCallId is superseded by the compatible batch-bound contract above.

| Review concern | Design disposition | Required implementation evidence |
| --- | --- | --- |
| Product, W1–W11 | Keep one checkbox and predictable off/on behavior | Real ordinary-chat off/on journey with no unexpected prompts |
| UX/accessibility, W1/W3–W7 | Keep current controls; restore failed saves; no routine UI noise | Keyboard/focus/status and save-failure/conversation-switch checks |
| Runtime, W1–W11 | Snapshot batches; preserve partial outcomes; never retry uncertain effects automatically | Mixed-call, toggle-race, cancel/retry/restart and failure-window tests |
| API/scheduler, W8–W10 | Preserve request compatibility and scheduler configuration; one persisted gate | Absent/false/true route matrix and old-receipt replay tests |
| Security, W1/W4–W11 | Preserve ownership/capability fences and safe argument handling | Stale/cross-run/cancelled decision and data-disclosure checks |

The separate implementation issue must link #469 and this document revision,
carry R1–R15 and these decisions, enumerate current files and production-path
tests, and preserve existing behavior outside the stated corrections. Changing
defaults needs no conversation backfill. Durable decision/receipt changes need
backward-compatible readers and explicit legacy-receipt migration tests. Rollback
must preserve decision records and avoid replaying any completed or uncertain
effect; reverting code alone is insufficient if a storage format has changed.
Runtime acceptance remains open in that follow-up; this document ships no runtime
or UI changes.
