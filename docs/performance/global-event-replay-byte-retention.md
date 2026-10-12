# Global event replay byte retention

The source traced at integration `d35499ddc226a6f79ec99c468e84e34908b98b8a`
has several independent buffering paths:

| Path | Existing bound | Remaining byte-retention concern |
| --- | --- | --- |
| Conversation replay channel | 1000 events; terminal cleanup from #764 | A single event can retain arbitrary payload bytes. Active and paused channel ownership is protected. |
| Global replay firehose | 5000 events per workspace; process lifetime | Original mutable event objects remain referenced after conversation cleanup and can grow after emission. |
| Durable append chain | Serialized ordering per conversation | Pending serialized lines have no aggregate byte admission under stalled writes. |
| Log cold sequence initialization / full replay read | Whole-file reads | File text, line splitting and parsed replay events can coexist without a byte cap. |
| Conversation and global SSE routes | Native stream queue; direct enqueue | Encoded whole frames are enqueued without consulting consumer demand or a queued-byte limit. |
| OpenAI-compatible streaming completion | Native stream queue and conversation replay | Fast-completion catchup depends on full conversation-buffer events; clipping those could lose response content. |

This proposal changes only the global best-effort replay cache. It retains
detached JSON records capped at 4 MiB of serialized UTF-8 per workspace and
16 MiB across the process, alongside the existing 5000-entry workspace cap.
Pressure evicts the oldest global prefix. Aggregate eviction removes every
cache reference and releases the emptied workspace buffer's backing array;
its emitter and sequence metadata remain to preserve live subscriptions and
reconnect high-water marks. Workspace-registry cardinality remains unbounded.

Admission walks bounded plain JSON data before serialization. Keys, separators
and array indices are conservatively charged, so an entry can be refused below
the cap. Oversized strings do not produce a complete serialized copy. Accessors,
proxies, callable JSON hooks, custom prototypes and cyclic data are uncacheable;
the optional cache must not invoke additional publisher callbacks. A rejected
entry clears that workspace's previous cached prefix, and later retained entries
form a fresh suffix. This avoids internal holes in the available suffix.

The global stream already offers only recent best-effort replay, without a
durable fallback or a new gap notification. Its existing `fromSeq` / Last-Event-ID
consumers can receive only the available suffix. Global sequence allocation and
live event objects remain unchanged, including oversized or uncacheable events.
The append tap still runs before global publication. Per-conversation replay,
authoritative conversation sequences, durable logs, terminal cleanup and active/
paused ownership remain unchanged. In particular, the completion route's fast
catchup is not clipped by this patch. #764 and its evidence remain frozen.

The caps account for cached JSON UTF-8 bytes. They do not bound actual JS string
storage, cache-entry/Map/array overhead, workspace metadata, temporary data clones,
JSON serialization/parsing peaks, V8 heap, external memory or process RSS.
Other subscribers, conversation rings, pending log strings and SSE queues can
still retain the same event through independent references. Fresh source loading
is required; this proposal does not migrate an existing hot-reload singleton.

Twenty-seven focused cases are authored but unexecuted: global/workspace/count
pressure, oversized events surviving terminal cleanup, UTF-8/escape accounting,
producer and reader mutation, refusal of getter/proxy/JSON callbacks, aggregate
storage release, suffix/cursor continuity, live/append ordering and preserved
paused ownership. The old integration event bus is the planned negative control
for the nine `bounds` / `detaches` / `resets` cases; these use existing replay
APIs and numeric byte observations rather than a missing diagnostic method.
The new pressure diagnostics also have a positive storage-release check.

The queue has not assigned a validation window. Owned dependency installation,
actual byte fixtures, #764 lifecycle cases, real conversation-log/SSE/sidebar
regressions and scoped lint remain required. Source fixtures use fake terminal
time and a mocked allocator/tap; real-log regressions remain separate. There is
no installed/native throughput, peak allocation, slow-client, elapsed endurance,
original production or independent A− acceptance claim from this proposal.
