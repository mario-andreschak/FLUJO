# Execution event channel cleanup

The source proposal keeps terminal conversation channels while subscribers are
connected and gives the last unsubscribe a fresh five-minute cleanup deadline.
Previously, a subscriber could outlive the original terminal timer; that timer
returned without deleting the channel, and unsubscribe never scheduled another
one. Its replay buffer could then remain for the lifetime of the process.

Each cleanup is bound to the captured workspace key, channel object and sequence.
Any later emit revokes terminal eligibility. Synchronous listeners that resume or
finish a run cannot let an earlier event cancel the newer cleanup or delete a
resumed channel. Unsubscribe is idempotent. An empty channel with no emitted
events is also removable after its final subscriber leaves. Running, paused,
approval and other nonterminal event channels retain their existing behavior.

This removes only an unused event channel. It does not remove conversation state,
durable logs, archive snapshots or authoritative sequence bookkeeping. Existing
event-count limits, firehose behavior, event delivery and the append tap remain
in place. Reconnection after cleanup still depends on the existing durable-log
replay route; that route's storage/restart behavior needs separate qualification.

The thirteen authored cases cover expired terminal timers, multiple listeners,
idempotent unsubscribe, empty channels, live/paused/approval retention, ordinary
and synchronous resumes, synchronous completion, workspace-bound unsubscribe,
reconnection and sequence/append-tap continuity. They have not been executed on
this source. A meaningful negative control is the old event-bus implementation:
the expired-subscriber and empty-channel cases should expose its retained channel.
The lifecycle cases use fake time, a workspace selector and a mocked log allocator
and append tap. They cannot qualify actual filesystem durability or restart replay;
the existing real-log and SSE replay suites remain part of the required validation.

This proposal does not impose byte limits on replay buffers, bound the process-wide
firehose registry, limit SSE queued bytes or make asynchronous log appends durable
before delivery. Slow clients, large-context/media admission, transient allocation,
full persisted history under pressure and post-warmup heap/RSS/external memory
remain required under #569. Native validation, original production confirmation,
elapsed endurance gates, release/manual evidence and independent A- reassessment
remain open.
