# Flow submission admission

Issue #569 includes a concrete retention path at the public `runFlow` boundary:
each submission could register cancellation and wait behind a conversation lock
while retaining its entire input. Neither the lock nor a per-parent subflow
worker pool limited aggregate submissions across conversations or workspaces.

Admission now occurs synchronously before the first asynchronous setup operation.
It reserves capacity while setup, lock waiting, execution and final persistence
remain pending. Nested child calls acquire their own capacity and refuse
immediately when full; parents do not hold a semaphore while waiting for another
permit. A private authority-delegation hop shares its existing reservation.

## Operational limits

The defaults are admission policy, not a measurement of total application memory.
Positive safe-integer environment overrides use the `FLUJO_RUN_ADMISSION_` prefix.
Invalid values retain the defaults.

| Suffix | Default | Resource |
| --- | ---: | --- |
| `MAX_PROCESS_RUNS` | 64 | Admitted setup, waiting and executing calls, all workspaces |
| `MAX_WORKSPACE_RUNS` | 32 | The same calls in one workspace |
| `MAX_CONVERSATION_RUNS` | 4 | The same calls for one workspace/conversation |
| `MAX_PROCESS_BYTES` | 512 MiB | Combined conservative input reservations |
| `MAX_WORKSPACE_BYTES` | 256 MiB | Reservations in one workspace |
| `MAX_INPUT_BYTES` | 64 MiB | One estimated input before expansion |
| `MAX_RSS_BYTES` | 2 GiB | Observed process RSS plus outstanding reservations |

Each reservation is at least 1 MiB and four times the estimated input. The
bounded data walk charges UTF-16 strings, keys, ordinary objects, array slots and
complete backing buffers, including inline media. It invokes no getters,
serialization hooks or proxy traps. Unknown data graphs, excessive depth or
cardinality refuse admission. Runtime capabilities are excluded from the walk.
File-backed media is a reference here; archive hydration retains its separate
descriptor and allocation limits.

The heap check retains 20 percent of the actual V8 heap limit plus 64 MiB of
headroom after current heap use and reservations. The RSS check includes native
and external allocations already reflected in `process.memoryUsage().rss`.
Reservations deliberately overlap materialized input and can conservatively
refuse work before physical memory is exhausted. They do not reserve OS memory.

`FLOW_RUN_BUSY` returns HTTP 429; `FLOW_RUN_MEMORY` returns HTTP 503. Both give a
five-second `Retry-After` hint. `FLOW_RUN_INPUT_TOO_LARGE` returns HTTP 413 and
requires smaller input, without a retry hint.
Initial refusal adds no waiting queue and performs no execution, conversation
mutation, provider dispatch or cancellation registration. A second check after
registration and lock waiting catches changed input or process pressure before
conversation mutation; late refusal also releases its registration. It does not
cancel another run. Callers must not mutate admitted input while it is pending;
the later check cannot undo an allocation the caller already made.

## Streaming and ownership

Flow completion streams reserve run admission before launching background work
or returning HTTP 200. An opaque, workspace/conversation-bound runtime permit
can authorize exactly one claim. The actual input is measured again before
execution, so a small preflight cannot authorize a larger input. Children need
their own permits. Setup, rejection and completion release reservations once.

A late pressure refusal after the response starts terminates only that request
with an OpenAI-shaped error frame and `[DONE]`. It never marks the existing
conversation failed or publishes a conversation-wide `run:done` event.

Paused, approval-owned and recovery-owned states remain in their existing cache.
Returning from a paused call releases submission capacity, not that state or its
ownership. Its retained memory still affects subsequent process-pressure checks.
The terminal cache continues to require successful persistence before eviction.

The authenticated operations status endpoint adds `flowRunAdmission`: numeric
process/workspace counts, reserved bytes, refusal counters and configured limits.
It includes no conversation IDs, workspace names, prompts or credentials. These
are diagnostic samples rather than an atomic view or an execution receipt.

Existing accepted calls keep their execution and persistence behavior. Clients
must handle the added 413/429/503 responses; a retry hint does not authorize
replaying earlier provider or tool effects. No stored-state migration is needed.
Rolling back this code restores the prior unbounded submission behavior and
removes the additive operations metrics; it does not modify persisted history.

## Qualification scope

This change bounds inputs retained by submitted `runFlow` calls. It does not
bound request-body parsing before submission, preconstructed task lists, growing
live histories, provider/SDK outputs, all media hydration, full final completion
payloads, or allocations made by already admitted work. Direct model completions
and durable Persona dispatch-envelope queues retain their existing boundaries;
the eventual Persona Flow execution uses the same public admission gate.

The original workload and archive negative controls remain separate equipment.
Several older performance documents describe superseded Source proposals:
current archive writers have a bounded waiting queue, and event replay shares
process/workspace byte ledgers. Those documents are not fresh runtime evidence.
This submission fix alone does not establish the adopted 24-hour Windows/Linux
RSS envelope, original-provider fidelity, installed release acceptance or full
#569 completion. Fresh results and their exact revision must be recorded in the
issue and PR before claiming qualification.

The finite admission/lock profile is reproducible without a provider:

```text
node scripts/qualification/flow-run-admission.cjs --output ABSOLUTE_NEW_DIRECTORY_OUTSIDE_CHECKOUT
```

It pins source and workload hashes, runs 64 independent large-input batches in
fresh default-heap guarded/control children, preserves all payload hashes and
lock ordering, samples heap/RSS/external/ArrayBuffer usage and allocation stacks,
and requires process/stdio settlement. Its comparison bypasses admission only
inside the harness and must fail the four-waiter invariant on every batch while
ordinary processing succeeds. Predeclared ceilings and post-warmup window growth
checks cover this finite module workload only. The caller owns evidence cleanup.
