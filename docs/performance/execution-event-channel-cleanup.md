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

The thirteen lifecycle cases cover expired terminal timers, multiple listeners,
idempotent unsubscribe, empty channels, live/paused/approval retention, ordinary
and synchronous resumes, synchronous completion, workspace-bound unsubscribe,
reconnection and sequence/append-tap continuity. All thirteen passed on Windows
with official Node 22.23.3, libuv 1.51.0 and default runtime options. An owned
`npm ci --include=dev` installed the locked Next 16.3.8 dependency tree; the local
dependency guard reported no issues. The guarded Jest runner executed each
explicitly selected suite with one worker and refused zero-execution success.
The lifecycle cases use fake time, a workspace selector and a mocked log allocator
and append tap. The real-log and SSE replay suites also passed all 52 assertions.
A new SSE case reaches eviction through the terminal timer and final unsubscribe,
then replays the persisted JSONL from a cursor, closes on the terminal event and
continues the authoritative sequence. It confirms conversation state remains
present when the event buffer is removed. Its TTL uses fake time, while log writes
and the replay route use their actual implementations and temporary files.

Replacing only the event bus with the old `d1029a7c` implementation produced
eight assertion failures and sixteen passes across the lifecycle and SSE suites:
expired subscribers, empty channels, deferred workspace cleanup, synchronous
resume/completion and terminal reconnection failed, including the new real-log
cleanup case. The proposed bus was restored byte-for-byte before positive checks.
Scoped lint passed with no warnings after changing a fixture's never-reassigned
unsubscribe declaration to `const`; the initial lint failure is retained. The
negative control used that fixture's earlier equivalent declaration. All 65
positive assertions ran after this repair, with no failures or skipped cases.
Full-project TypeScript validation was deferred by the integration queue for host
capacity, and other native profiles remain unqualified for this change. These
checks do not establish crash durability, a real process restart or elapsed
endurance. The frozen source-only receipt for `aed47491` remains historical.

This proposal does not impose byte limits on replay buffers, bound the process-wide
firehose registry, limit SSE queued bytes or make asynchronous log appends durable
before delivery. Slow clients, large-context/media admission, transient allocation,
full persisted history under pressure and post-warmup heap/RSS/external memory
remain required under #569. Native validation, original production confirmation,
elapsed endurance gates, release/manual evidence and independent A- reassessment
remain open.
