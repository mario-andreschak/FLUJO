# Bounded conversation publication

Conversation snapshots, JSONL appends, and transcript replacement share one
process-wide publisher and a workspace-qualified conversation queue. Other KV
collections retain their existing storage policy. These bounds describe this
publication boundary, not a whole-runtime or endurance qualification.

## Admission and capture

The fixed policy is 64 admitted owners (including nested snapshots), four active
writers, 256 MiB of aggregate retained string/metadata accounting, and 128 MiB
per capture. A capture visits at most 262,144 JSON slots and 128 nesting levels.
The publisher also observes the existing allocation reservations, heap headroom,
and runtime RSS limit. It does not increase any runtime memory limit.

Admission measures descriptors synchronously before queue, authority, or
workspace waits. A second synchronous pass copies containers while sharing
immutable string primitives. Every serialized use of an alias is charged, so
aliases cannot amplify an admitted payload indefinitely. The 2M-character parent
plus eight lanes totalling 37.6M owned characters fits this policy without a
whole-history stringify or structured clone. Media stays represented by its
existing references.

Plain JSON objects, null-prototype objects, and genuine foreign-realm plain
objects/arrays are supported. Undefined, function, and symbol object values are
omitted; array values become null, matching native JSON. Nonfinite numbers,
escaping, Unicode pairs, and lone surrogates retain JSON semantics. Accessors,
proxies, cycles, custom serializers, and non-JSON class instances are refused
without executing their hooks. Runtime authority, cancellation, emitter, trace,
and MCP context fields are excluded from snapshots. Durable conversation types
use numeric timestamps and plain provider metadata; Date/Buffer serializers are
not silently invoked as a compatibility fallback.

The encoder uses an 8,192-character string window and reusable 64 KiB byte
buffer, including partial-write handling. Queued captures are bounded, siblings
inside one transaction serialize, and a root writer remains occupied until its
nested work settles. Diagnostics expose only numeric owners, writers, captures,
allocation bytes, queued writers, fences, receipts, and quarantined writer slots.
The allocation observer has one fixed `publication` slot.

## Transcript replacement

Replacement appends context tombstones and replacement messages; it does not
copy or rewrite the old audit log. One owned log descriptor spans metadata
inspection, append, snapshot publication, and possible rollback. Long string
tokens are skipped before parsing metadata, with at most 1 MiB of transformed
JSON per record, 262,144 structural tokens, 128 nesting levels, 65,536 projected
IDs, 1 MiB of active ID characters and 1 MiB of historical legacy-ID keys, and
4,096 characters per ID. A 32 MiB scratch reservation precedes this work and lasts through the
transaction. The snapshot fallback uses the same bounded ID walk.

Only a definitely uncommitted snapshot permits truncation back to the original
length. The open descriptor, named file, suffix version, parent, workspace, and
execution authority must still match. A successful rename is a commit even if
its acknowledgement or a later ownership check fails. Unknown rename, append,
rollback, or close outcomes retain the new log/live transcript for reconciliation;
they never trigger a guessed rollback. A rollback failure preserves the primary
snapshot error.

Bus events receive sequence numbers synchronously. Replacement therefore
reserves an interval of `65,536 + replacement.length` before it waits, ensuring
later independently stamped bus events cannot appear earlier in file order.
Events consume the tail of that interval so the final durable event seals its
high-water mark for cold restart scans. Unused values remain intentional gaps;
sequence values remain strictly ordered, and SSE resume uses comparisons rather
than contiguous arithmetic. Capture
admission failure precedes interval reservation. No IDs, dispatch markers, or
canonical history are truncated to satisfy a memory limit.

## Uncertain outcomes and restart

Before mutating either durable file, publication creates and syncs a small
exclusive intent at `db/conversation-publications/<conversationId>.json`. It
contains version, conversation ID, token, and start time, never a transcript.
The intent spans a complete replacement transaction and is removed only after
settled I/O and verified ownership. Unknown outcomes retain it. A later process
refuses publication when this intent exists, so it cannot concatenate a new
event onto an ambiguous partial record after restart.

The live process retains bounded path/inode/offset receipts and a finite owner
slot for reconciliation, releasing large captures once I/O settles. Uncertain
descriptor closure also retains its writer-capacity slot (at most two data-file
descriptors per writer during replacement). Once all four slots
are quarantined, every queued waiter is refused and drained. Restart does not
clear the on-disk conversation fence: recovery must reconcile the intent against
the snapshot, log, and surviving temporary files before removing it. This slice
does not guess an automatic winner or provide an operator action that discards
an unresolved intent.

Required publication failures use typed busy, memory, data, I/O, or uncertain
errors. A bus failure becomes a fence observed by the durability flush. Terminal
cleanup recognizes these errors, preserves a preceding execution failure, and
does not report successful persistence after the final snapshot retry fails.

Focused tests cover bounded queued ownership, blocked-authority capture,
foreign JSON, large shared strings, partial writes, nested transaction lifetime,
SSE resume across sequence gaps, precommit rollback, committed-but-rejected
rename acknowledgements, restart fences, rollback/close failures, prior fold
reconciliation, and preservation of the original execution error. They do not
establish whole-runtime, native-provider, or 24-hour endurance behavior.
