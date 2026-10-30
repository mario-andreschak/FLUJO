# Conversation sequence bootstrap and registry ownership

Conversation event numbers remain process-owned high-water marks, seeded from
the maximum valid root `seq` in the complete durable JSONL snapshot. A legacy
file containing sequence 7 followed by 3 still starts at 8. No history is
rewritten, truncated or silently made durable by sequence admission.

## Bootstrap allocation and work

Cold bootstrap uses one regular-file descriptor, a 64-KiB buffer, bounded JSON
grammar state and at most 128 characters of a root sequence numeric token.
It never materializes a whole line, string value, key, parsed event or file.
It validates complete roots before accepting their sequence: malformed lines
are ignored, nested/string lookalikes do not count, escaped root keys work, and
the final duplicate property wins even when that final value is nonnumeric.

The scanner checks every line in the original descriptor snapshot. It does not
use a tail heuristic or a maximum file-size cutoff. Allocation is bounded by
128 container levels and retains no strings. Work is not limited by default, so
a long or old conversation is always continuable; callers (and
`FLUJO_CONVERSATION_SEQUENCE_SCAN_MAX_MS`) may still opt into a token or time
budget, whose refusal is never a partial successful scan.

Run paths (`runFlow`, streaming chat completions) and `latestSequence` first
seed the counter with an asynchronous scan that yields between fixed-size
reads, so a large history does not stall other chats and streams. The
synchronous scan remains the fallback for the bus's synchronous emit path.

Only an absent pathname (`ENOENT` on open) seeds zero. Open/read/stat/close
failures, nonregular files and descriptor snapshot changes fail explicitly.
Short reads continue; early EOF refuses. Final size and modification/change
timestamps are checked on the same descriptor, without reopening a potentially
retargeted pathname. Existing in-memory sequence ownership is not reset.
Virtual bus channel IDs that are ineligible for persisted logs retain bounded
in-memory sequences and never reach a filesystem pathname.

Four process-wide slots admit asynchronous cold scans, which wait for a free
slot. A synchronous scan cannot wait and never overlaps another synchronous
scan, so it is always admitted. Every scan releases its slot when it settles,
including after an uncertain close; the numeric descriptor is never retried
because it may have been reused, and a completed scan result stays valid.
Existing in-memory sequence owners and virtual channels continue. A primary
scan error remains authoritative if closing also fails, while numeric
`scanActive`, `scanQuarantined`, `scanRefusals`, and `maxColdScans` diagnostics
expose the retained ownership. The ledger survives server-bundle reloads.

Numeric sequences must be safe integers. Negative legacy sentinels are ignored;
fractions and unsafe/nonfinite numeric values refuse. Allocation also
requires a safe integer successor, so it cannot emit a sequence for which
`seq + 1 === seq` or reuse the final admitted integer.

## Bounded registry with no eviction

The process retains at most 4,096 newly admitted sequence keys, with independent
limits of 8 KiB per key and 4 MiB in aggregate. Accounting charges UTF-16 key
storage plus a 96-byte entry allowance. Ordinary workspace-qualified UUIDs fit
well below the per-key limit; the byte ceilings independently cover atypical
long identities. Diagnostics expose counts, estimated key bytes, refusals and
limits, never workspace/conversation identities or content.

Every existing key keeps its high-water mark. A new key is refused before the
disk scan/insertion if capacity is exhausted; existing owners continue. An
already oversized map inherited during hot reload is retained and reported,
and new keys are refused. Numeric accounting is shared across server bundles;
normal admission is constant-time and retains no second per-key metadata map.

This deliberately does not use idle LRU eviction. Transient, ephemeral and
unknown-state bus events allocate sequences without a durable append. Failed
appends, transcript rollback and deletion can also leave an allocated high-water
mark above disk. Empty append chains do not prove safe reconstruction. A future
eviction design needs explicit durable/lifecycle ownership and mutation pins.
Until then, capacity requires draining active work and a controlled restart;
there is no misleading short `Retry-After` promise or silent ephemeral write.

## Failure propagation

The typed codes are `CONVERSATION_SEQUENCE_SCAN_LIMIT`,
`CONVERSATION_SEQUENCE_SCAN_BUSY`,
`CONVERSATION_SEQUENCE_IO`, `CONVERSATION_SEQUENCE_CHANGED`,
`CONVERSATION_SEQUENCE_EXHAUSTED` (HTTP 503), and
`CONVERSATION_SEQUENCE_REGISTRY_FULL` (HTTP 429). A run preflights its effective
conversation ID before state registration/provider execution. Streaming
completion requests additionally preflight before returning their stream.

The event-bus convenience emitter rethrows this safety-error family instead of
logging and dropping it. Mid-run failures remain latched: subsequent normal
emission cannot authorize another dispatch, while error finalization avoids
recursively stamping another event for the same failure. A direct child recovery
append that fails during existing-error cleanup preserves the original failure
and persists its already-classified snapshot through the normal persistence
chokepoint. This does not invent a replacement log sequence or an actual provider
dispatch receipt. Startup and terminal event failures also reach terminal
cleanup, preserving completed dispatch history and releasing owned resources.
The real ModelHandler SDK observation callbacks and provider adapters treat
sequence safety as fatal before physical dispatch; ordinary archive diagnostics
retain their existing best-effort behavior.

## Limits of this slice

Sequence-key accounting is an admission estimate, not a measurement of all V8
memory. Existing live histories and previously oversized registries remain
owned. Pending serialized append strings, whole-log transcript rewrite/rollback
buffers, and downstream snapshot serialization still require separate budgets.
This change does not establish a whole-runtime or 24-hour memory envelope.
