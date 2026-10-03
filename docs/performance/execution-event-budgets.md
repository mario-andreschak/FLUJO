# Execution replay and SSE resource boundaries

ExecutionEventBus is a disposable projection of canonical state and durable
conversation JSONL. It now retains immutable serialized snapshots instead of
full mutable transcript/tool/media graphs. Every event still reaches the
existing canonical persistence tap, including dispatch markers and payloads
too large for the live projection. No run, approval, recovery owner, canonical
history or persisted media is deleted to satisfy these budgets.

## Implemented defaults

| Resource | Default ceiling |
| --- | ---: |
| One execution event's JSON wire payload | 256 KiB |
| Conversation replay entries | 1,000 and 4 MiB accounted retention |
| Workspace firehose replay entries | 5,000 and 8 MiB accounted retention |
| Aggregate process replay retention | 16 MiB |
| Conversation projection metadata | 1,024 channels |
| Workspace projection metadata | 64 firehoses |
| Terminal channel retention with no listener | 5 minutes |
| One active SSE queue | 1 MiB, including 1 KiB reserved for control |
| Active SSE subscriptions | 64 per process, 16 per workspace, 4 per conversation |
| Simultaneous durable SSE replay reads | 4 |
| One durable SSE replay snapshot | 1 MiB file bytes and 1,000 selected events |

These are source defaults for this slice, not independently accepted scorecard
budgets or an overall process-memory guarantee. Replay accounting includes a
UTF-16 string estimate and per-entry overhead, conservatively charging both
channel and firehose references even when they share one JSON snapshot. Both
count and byte ceilings apply. Oldest disposable entries go first; subscribed
channels/firehoses keep their subscription identity. Metadata eviction can
remove an unsubscribed projection of an active run; its executor/state/history
and ownership remain intact. A missing projection requires snapshot recovery.

JSON size is checked before stringify, with bounded value/depth traversal and
UTF-8/escape accounting. Cycles, accessors, opaque instances and callable
toJSON hooks are rejected for projection without invoking those hooks. Large
events remain canonical and cause live consumers to reload their snapshot.
There is no event-identity snapshot cache that could retain extra strings on
caller-owned event objects beyond the replay ledger.

The stream uses a byte queuing strategy and checks desiredSize before encoding
or enqueuing another frame. Overflow emits a small control frame and closes the
subscription synchronously; callbacks, heartbeat and abort listener are
released. Excess subscriptions return HTTP503 with Retry-After: 3. Admission
limits subscriptions; it never grants or cancels execution authority.

Bounded durable recovery reads a fixed-size file snapshot after checking its
size, so growth after stat cannot cause an unbounded readFile allocation. Full
history readers retain their existing API. A log exceeding the SSE limit uses
snapshot recovery; the large file and canonical history remain available.

## Version 1 consumer contract and migration

The event data schema is unchanged. The additive named SSE frame is:

```text
event: flujo-stream-control
data: {"version":1,"reason":"replay-gap","recovery":"reload-snapshot","nextSeq":42,"epoch":"optional-workspace-epoch"}
```

Reasons are replay-gap, cursor-reset, slow-consumer and event-too-large.
This is a delivery/recovery notice, never an execution event, terminal success,
ACK, spend receipt or inference/replay authorization. Close the old EventSource,
reload the relevant authoritative conversation/list/graph snapshot, then create
a fresh subscription. Per-conversation readers may start at nextSeq. Throttle
repeated recovery rather than retrying a missing projection in a tight loop.

Per-conversation IDs remain durable numeric seqs. Latest-run replay clamping,
strict deduplication, activity-only replay and the latest run:done terminal
guard are preserved. Bounded durable recovery can fill interior omissions;
activity-only recovery does not read full history.

Global IDs now use `<workspace-epoch>:<globalSeq>`. Global sequences are
disposable; the epoch changes on process/firehose recreation. Last-Event-ID
wins over the initial query on reconnect. For explicit replay, provide
fromSeq=N and epoch=the observed current epoch, or fromSeq=epoch:N. Legacy
numeric/stale/future cursors receive cursor-reset rather than silently skipping
activity. A cursor below the retained gap floor receives replay-gap. A global
snapshot reader can reconnect without a cursor after rehydration.

The owned FLUJO Chat, sidebar and Chain Chat readers handle control callbacks,
refetch their projections and delay reconnection by three seconds. Chat guards
late recovery by subscription generation and selected conversation. External
Brain/History/Observatory owners must adopt the epoch cursor and named-control
contract and retain exact consumer pins. Existing numeric-only readers are not
qualified by this backend PR. Root must coordinate that migration before
deploying this contract to those readers; this is an actual changed interface.

## Verification and remaining acceptance

Focused source tests exercise aggregate/workspace/conversation byte and count
pressure, metadata capacity, immutable replay, oversized canonical media,
Unicode/escaping, unsafe serialization, subscriber-preserving cleanup,
non-reading HTTP/SSE consumers, abort/cancel during async replay, HTTP503,
interior durable omissions and stale/legacy global cursors. Named control is
tested separately from execution events; Chain Chat's mounted test verifies
snapshot refresh, delayed reconnect and cancellation on unmount.

Diagnostics return counts, accounted bytes and numeric limits, without prompt,
media, conversation ID or authority contents. The source tests are not a
whole-process allocation/RSS endurance qualification. Active state, canonical
history/cloning, SDK buffers, log-write queues, allocator maps, Next/HTTP/socket
buffers, closed-stream drainage and downstream/browser retention require the
predeclared integrated runtime load/slow-client/concurrency/overload harness.
Preserve default-heap build evidence separately from runtime budgets. Original
#520 provider, #515 deployed ap-* workflows, Persona latency/RSS/growth limits,
elapsed live/manual acceptance and independent A- reassessment remain open.
