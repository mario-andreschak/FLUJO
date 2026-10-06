# Execution replay and SSE budgets

This is the Source proposal port of #621 onto `115c916d793a1c162be6fd1bd3917d71a24e61c0`.
Its tests, compiler checks and operational qualification are **UNRUN**. The old
#621 verification does not qualify this implementation or base.

## Retained projections

| Resource | Limit | Accounting |
| --- | --- | --- |
| Combined conversation and global replay, one workspace | 4 MiB | Actual UTF-8 bytes of both stored JSON strings |
| Combined conversation and global replay, process | 16 MiB | The same shared ledger across workspaces |
| Conversation replay | 1,000 events; at most 4 MiB | Also charged against both shared limits |
| Global replay in a workspace | 5,000 events; at most 4 MiB | Also charged against both shared limits |
| Conversation channel metadata | 1,024 channels | Evict an unsubscribed projection at capacity |
| Global workspace metadata | 64 firehoses | Evict an unsubscribed firehose at capacity |

The shared ledger counts the conversation JSON and global-wrapper JSON
separately when both exist. It does not pretend that the duplicate payloads
share storage. Workspace or process pressure evicts the oldest retained prefix
across the two caches. Each projection still reports its own actual retained
bytes; `getReplayPressure()` reports the combined reservation. Eviction,
terminal cleanup and uncacheable-event resets release all corresponding ledger
references. Empty workspace ledgers are removed.

Replay returns detached data. Producer or replay-reader mutations cannot grow
the retained cache. The bounded serializer rejects proxies, accessors, cycles,
custom prototypes and JSON hooks without invoking publisher callbacks. Its
conservative data walk stops at depth 64, 100,000 values or the byte budget
before building a full JSON string. Some otherwise small values are uncacheable.

Live consumers and the persistence tap still receive the original event.
Durable sequence allocation, canonical conversation state, paused execution,
owner authority and cancellation remain separate from disposable projections.
Projection eviction does not cancel, acknowledge or restart a run. If all
metadata slots have listeners, further projection admission fails while the
event's durable tap and available live projections continue.

## FLUJO SSE routes

These limits apply to `/v1/chat/events` and
`/v1/chat/conversations/{conversationId}/events`.

| Resource | Limit | Behavior at the limit |
| --- | --- | --- |
| Active streams, process | 64 | HTTP 503 with `Retry-After: 3` |
| Active streams, workspace | 16 | The same response |
| Active streams, conversation and workspace | 4 | The same response |
| ReadableStream byte queue, each stream | 1 MiB | Recovery frame and close |
| Event JSON payload sent on the wire | 256 KiB | Recovery frame and close |
| Reserved queue space for a recovery frame | 1 KiB | Kept out of ordinary event/heartbeat admission |
| Concurrent native durable replay reads, process | 4 | Recovery frame and close; no waiting queue |
| Durable replay file buffer | 1 MiB plus one growth-sentinel byte | Refuse larger or non-regular descriptors before allocation |
| Scanned durable replay lines | 1,000 | Recovery frame and close |

Stream admission follows the existing lock, ownership and exposure checks and
precedes subscription or replay I/O. Heartbeats consume the same byte queue.
Releasing a reader releases its stream permit and subscription immediately.
Cancellation also aborts replay's lifetime signal, but the native-read permit
stays held until the in-flight read and descriptor close settle. Async setup
does not delay body cancellation. Release functions are idempotent.

Durable replay opens one read-only descriptor, checks its type and size, reads
in chunks of at most 64 KiB, and uses a sentinel to reject observed growth or
shrinkage. Oversized, malformed or unavailable replay triggers snapshot
recovery. This reader is a bounded projection, not an atomic snapshot of
concurrent file mutations. Full-history readers and durable writes retain
their established behavior.

The application byte queues have a nominal aggregate ceiling of 64 MiB,
independent of the shared 16 MiB replay ledger. These are serialized-retention
and application-queue bounds. They do not measure JS heap, object/Map overhead,
temporary clones, parsed replay values, response adapters, kernel/proxy/socket
buffers or draining speed. Source provides no RSS or slow-client qualification.

## Recovery and compatibility

Default SSE IDs remain numeric. Conversation IDs retain their durable sequence
meaning. The global route adds `cursorVersion=1`: IDs become `epoch:seq`, and a
versioned `fromSeq` must use that format. The owned sidebar reader opts in.
Global `Last-Event-ID` now wins over the initial query cursor, as it already did
for conversation reconnections. Malformed, negative, unsafe or out-of-range
cursors request recovery. An epoch mismatch is detected only for opted-in
readers; legacy numeric cursors within a recreated firehose's range cannot
prove epoch continuity.

When a projection cannot safely replay or enqueue an event, the server sends
the named `flujo-stream-control` event with `version: 1`,
`recovery: "reload-snapshot"`, a `nextSeq`, and one of `replay-gap`,
`cursor-reset`, `slow-consumer` or `event-too-large`. Versioned global controls
also include the epoch. The frame clears the browser's previous SSE ID and
closes the stream. It is a transport/projection instruction, never an execution
event or acknowledgement. Existing execution event bodies are unchanged.

The service closes the EventSource before passing a valid control to `onReset`.
Chat, the sidebar, Chain Chat and Avatar reload their canonical projections and
use a three-second reconnect delay. Conversation readers use activity-only
recovery and the supplied next sequence; their generation and cleanup guards
prevent retired streams or timers from reattaching. Latest-run replay clamping,
initial transcript filtering and terminal-event ordering remain in place.
HTTP admission rejection is distinct from a control frame; `Retry-After` is a
hint, not evidence that a browser or external reader will retry correctly.

The OpenAI-compatible completion stream has its own protocol and receives no
FLUJO control frames. Its request captures the sequence before dispatch so a
previous terminal run cannot end the new request. When its replay is incomplete,
it uses full final assistant messages and recovers missed terminal output from
canonical state, using the captured append/resume message boundary where
available. Native deltas remain incremental when that request's replay is
complete. Body cancellation unsubscribes. This adapter's queue and full final
conversation payload are outside the FLUJO SSE queue and wire limits above.
Its projection metadata admission can return HTTP 503 after dispatch; that
does not cancel or authorize resubmission of the existing run.

External Brain/History/O readers and third-party EventSource clients must adopt
named recovery controls. Source compatibility of numeric IDs alone does not
establish their recovery, adoption, socket behavior or release readiness.

## Required later qualification

The Source regression selection covers cross-cache byte sums and releases,
mutation detachment, existing global caps and cleanup, admission, bounded
descriptor replay, cancellation, queue overflow, cursor versions, ownership
gates, activity and latest-run ordering, all owned recovery consumers, and
OpenAI fast/resumed output. No selected fixture has been run for this commit.

Queue's installed checkout requires a fresh Root qualification handoff after
Source review. This proposal supplies no acceptance, soak, paid/provider,
native or deployment result. #569 still needs operational retained-heap/RSS and
slow-client evidence. The original #520 workload's cause and redacted workload
confirmation remain unproven. Root alone owns the #563 maturity checkpoint.
