# Legacy outcome streaming and JSON allocation admission (#569 / #520)

Legacy v1 outcome updates previously decompressed, parsed and serialized the
complete archive on every update. Byte-valid 60 MiB histories exhausted a
128 MiB Node heap even after adding the 32 MiB compressed / 64 MiB decoded limits.
Dense request arrays inflated objects independently of encoded byte size.

Outcome updates now use one descriptor, 64 KiB chunks, backpressured gzip streams
and an atomic temporary-file replacement. A narrow incremental JSON validator
changes only `root.entry.outcome`; every other decoded byte, including history,
SDK parameters, retry identity and media references, is preserved. Escaped keys,
arbitrary field order, duplicate keys, missing outcomes, strings, numbers,
literals and nested arrays/objects are validated across chunk boundaries.
Malformed JSON/gzip, invalid UTF-8, size overflow and publication failures leave
the original file unchanged and remove the temporary output. Control frames
have an operational ceiling of 65,536 nesting levels; no transcript object is
constructed. Both decoded replacement and compressed output keep the existing
64 MiB / 32 MiB limits. The existing four-pipeline, no-queue allowance remains
held through replacement. Workspace ownership is rechecked before opening the
output pipeline and immediately before publishing its result. V2 immutable
snapshots and small outcome companions are unchanged.

Object-returning inspection reads separately reserve a conservative allocation
allowance while incrementally inflating JSON, before retaining each chunk and
before `JSON.parse`. The shared reservation ceiling is **128 MiB**, with
**64 MiB heap headroom** below V8's configured heap limit. Charges include eight
bytes per decoded byte, two per compressed byte, and structural charges for
strings, containers, properties and scalar values. These are admission estimates,
not a measured whole-process RSS guarantee or an exact V8 object-size formula.
Structural charges prevent tiny encodings of many objects from bypassing byte
accounting. A single input or the aggregate of readers that cannot fit returns
the existing typed `MODEL_TURN_ARCHIVE_READ_LIMIT` / HTTP 413 for an individual
input that cannot fit, or `MODEL_TURN_ARCHIVE_READ_BUSY` / HTTP 429 for aggregate
pressure that can be retried after another reader finishes, without changing
persisted archives. Native decoder closure completes before reservation release.
Original JSON/gzip/storage errors and abort reasons remain
available. Reservations remain held through the admitted callback's awaits;
they are released when that callback returns or fails.

The allocation refusal is containment, **not successful near-limit inspection**.
Returned snapshot objects, response serialization, slow clients, media hydration,
Native private-reader integration and retained active/paused/approval/recovery
state need independent lifetime measurements. Returning four independent 60 MiB
objects under a 128 MiB heap requires a different response/lifetime contract.
`parseBoundedModelTurnJson` is available for a private reader after its existing
descriptor/path identity checks; it does not replace those checks.

## Verification and limits

Focused tests exercise byte preservation at one-byte and larger chunk boundaries,
escaped/duplicate/missing keys, malformed JSON grammar, native JSON semantic
comparisons, failure cleanup, ownership loss before publication, input/output
ceilings, dense-object refusal before parsing, and reservation lifetime.

The controlled Windows Source workload uses complete legacy snapshot metadata,
60 MiB decoded plain-text and two-byte-string histories, a dense object-array SDK
request, repeated updates, and four distinct concurrent updates. Its declared
budget is an official Node 22.23.3 **128 MiB heap / 512 MiB RSS**, without explicit
GC. The supervisor samples native peak working-set bytes, while the child records
heap, external and ArrayBuffer allocation samples. History hashes normalize only
the edited outcome and verify all remaining decoded bytes. Four concurrent large
object reads are explicitly classified as limit refusals, rather than successful
inspection. Exact commit/file hashes and natural exit/error receipts accompany
each run; pre-fix heap-OOM and RSS-supervisor-stop evidence is retained separately.

This slice does not establish #569's full warmup/runtime acceptance, successful
large-object response lifetimes, Linux runtime qualification, live provider-error
resumption, or original #520 crash closure. It does not evict owned runs, raise
the probe heap, discard persisted history, deploy a worker, or replace existing
capped-child and HTTP-400 regressions.
