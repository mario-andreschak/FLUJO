# Bounded run-resource copies

`copyRunResourceToConversation` copies subflow and meeting media into the
destination conversation's ownership scope. Previously it called the ordinary
full-file reader, encoded the payload into text/base64, and passed that value to
the ordinary writer, which decoded another complete buffer. The same 32 MiB
binary resource could therefore retain two full buffers plus its base64 string
during promotion.

Copies now open the source once and stream its initial snapshot through one
reusable **64 KiB** buffer into a new exclusive destination file. The complete
SHA-256 is calculated over the copied bytes. Partial reads and writes are handled;
short EOF, changed size/mtime, and I/O failures prevent publication and remove
the partial destination. Atomic source pathname replacements leave the opened
descriptor's original bytes and digest coherent. Deliberately restored timestamps
on an in-place rewrite are outside this snapshot guarantee.

The actual source descriptor size is charged against the existing settings:
**50 MiB per resource and 256 MiB per conversation by default**. Both checks
precede buffer allocation and destination creation. The conversation check,
complete payload write, named overwrite and index publication use the same
serialized transaction as ordinary resource writes. Conversation occupancy is
still accounted from persisted index entries. MIME/kind/encoding, archive metadata,
source origin and producer lineage remain present; destination identity and
empty read/verification lineage follow the existing copy contract. Links keep
their original remote origin without a payload copy.

Process-wide admission allows **four active copies and eight queued requests**.
Queued copy tasks have not loaded their source index, opened payload files or
allocated a copy buffer. Beyond capacity, the operation returns
`{ skipped: 'copy-pressure' }`; retry after current copies finish. Existing media
callers retain the source reference on any skipped copy. The source payload and
its owning conversation remain available. `getRunResourceCopyPressure()` exposes
only active/queued/rejected counts and capacity, without resource IDs or content.
There is no unbounded per-workspace pressure registry.

Workspace mutation admission comes before copy admission. A new copy waiting
behind a recovery snapshot cannot reserve a slot required by an already admitted
mutation that the snapshot is draining. The four active reservations transfer
directly to queued work in FIFO order, so a newly arriving request cannot steal
a released slot. Workspace snapshot/process-writer admission is a separate gate;
its waiters are outside the copy-queue bound.

The index cache is published only after the atomic index write succeeds. On a
failed or ambiguous write, the cache entry is invalidated and the next operation
reloads disk. An ambiguous index failure preserves both old and new payloads:
deleting the new payload could remove bytes already referenced by a completed
rename. Recovery cleanup of unreferenced complete payloads remains separate.

Source qualification uses default quotas and a real 32 MiB file with misleading
small source-index metadata. Additional fixtures cover quota refusal before
copy I/O, concurrent conversation checks, partial I/O, text/archive lineage,
source replacement/growth/truncation, named overwrite/hard links, destination
failure, index failures before/after rename, empty/missing/nonregular files,
overload/draining, and recovery snapshot ordering. Destination occupancy fixtures
explicitly populate the index's accounting values; they are not a runtime memory
workload. Whole-file promotion, stale source-size accounting, excess admission,
incorrect snapshot ordering and premature index-cache publication are behavioral
negative controls to retain with exact-head qualification.

The copy-buffer envelope is at most **256 KiB per process**; this does not include
index/metadata objects, filesystem/kernel buffers, ordinary reads/writes, media
hydration, transcripts, model/SDK clones or archive queues. It is not the #569
whole-process runtime envelope. Integrated Linux/Windows checks, large-context
allocation/RSS profiles, the proposed 24-hour runtime budget, original #520
provider workload, elapsed Persona gates, installed/manual use and independent
A- acceptance remain open. This slice does not change the eight-file original
provider source receipt or reduce configured flow parallelism.
