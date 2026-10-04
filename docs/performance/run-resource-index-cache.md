# Run-resource index cache proposal

This source proposal addresses the process-wide resource metadata cache in #569.
It has not yet been executed or accepted. It does not establish the application's
runtime memory envelope, close the original #520 workload, or satisfy A- gates.

The former map retains every loaded conversation index. A cold read can also
finish after a writer publishes a newer index and overwrite the cached metadata
with its older snapshot. Read errors other than absence formerly become an empty
index, allowing a subsequent writer to replace inaccessible or corrupt history.

The proposed cache retains at most 200 indexes and 8 MiB of their encoded UTF-8
JSON metadata. Reads refresh least-recently-used order. An operation or pressure
snapshot lazily removes indexes idle for thirty minutes. Oversized indexes are
read in full and persisted normally but bypass retention. Eviction drops a
reloadable catalog reference; it removes no disk history, payload, execution
state, approval, active/paused owner or provider dispatch marker. It is not a
terminal execution-state eviction policy.

The weight covers encoded JSON only. Keys, parsed objects, full-file decoding,
JSON parsing/freezing, public metadata copies, writer buffers, directory scans
and aggregate listing allocations are outside that byte measure. The proposal
adds parsing of committed JSON on publication to ensure the cached snapshot
matches disk bytes even if an input object changes during an awaited write.
Workload allocation and latency consequences remain unprofiled.

Cold reads coalesce by workspace/conversation before admission. At most four
distinct loaders run; sixty more wait without opening or reading their index.
A sixty-fifth distinct load refuses with `RUN_RESOURCE_INDEX_PRESSURE` and a
retry hint. A caller joining an admitted key does not consume another loader
slot. This bounds distinct index IO, not total HTTP requests, same-key waiters,
workspace mutations or payload writers. HTTP resource listing returns 503 with
`Retry-After: 1` after the existing authority checks. Other read errors remain
errors and retain the route's redacted 500 response.

Only successful atomic index writes publish cache entries. Publication,
ambiguous write failure and deletion invalidate any older pending read. A cold
reader uses a newer committed cache entry or retries disk at most twice; three
continually invalidated reads refuse instead of exposing an obsolete history.
Deletion invalidates again after its serialized removal because a writer ahead
of it may publish after the initial invalidation. Non-ENOENT errors, corrupt
JSON and non-array roots cannot substitute an empty history for a mutator.

Cached snapshots are privately parsed from their encoded bytes and deeply
frozen. Public store APIs return independently mutable metadata copies, so
caller edits cannot grow the cache after its measured weight or alter later
history writes. Copies contain metadata only, with no resource payload buffers.
Pressure metrics contain counts, byte weights and limits, with no keys, resource
URIs, paths or payloads. The prior unbounded global map is released on module
initialization; mixed old/new route bundles require a process restart. The test
directory-reset seam detaches pending reads without cancelling their admission
slots and must be used after owned operations drain.

Prepared qualification includes the unchanged resource store, concurrent lineage,
bounded payload and copy suites, plus new source fixtures for count/byte/LRU/idle
bounds, coalescing, overload before IO, fixed retry count, old cold reads versus
committed writes, cache eviction/reload, public metadata mutation, deletion and
corrupt/permission-denied history. The deterministic storage race holds a writer
after its index load, evicts that cache entry, captures the old disk snapshot,
publishes the writer's new history, then finishes the old read. It uses barriers
without sleeps or relaxed assertions. Positive/type/lint qualification and
behavioral negative controls are pending; no test pass is claimed by this file.
