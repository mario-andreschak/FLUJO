# Model-turn archive inspection bounds (#569 / #520)

The #803 source still reads complete compressed snapshots and media files with
`readFile`, and snapshot inflation uses the default zlib output ceiling. Multiple
inspection requests can therefore allocate multiple copies of a large or highly
compressible archive. This change bounds the read/decode stage of inspection.

| Process-wide inspection limit | Bytes / count |
| --- | --- |
| Active snapshot/media read pipelines | 4 |
| Compressed snapshot, including historical v1 | 32 MiB |
| Decoded snapshot JSON | 64 MiB |
| Archived media body | 32 MiB |
| Descriptor read chunk | At most 64 KiB |
| File growth probe | One byte beyond the admitted descriptor size |
| Waiting inspection queue | 0 |

The 32 MiB file ceiling matches `mcp-servers/filesystem/src/tools.ts`'s existing
media limit, 64 MiB matches the conversation-cache payload budget, and four
active reads matches `src/backend/services/runResources/indexCache.ts`. These
limits do not raise any existing product, test or process-heap limit.

Read admission rejects a fifth pipeline immediately, before archive I/O, with
`MODEL_TURN_ARCHIVE_READ_BUSY`. Snapshot and media retrieval share one admission
slot. Admission spans opening, descriptor reads, decompression, JSON parsing and
outcome-sidecar reads, and releases on success or any failure. Its only retained
bookkeeping is a process-wide active count and saturated rejection count.

Request cancellation is checked before admission/open/allocation, between file
reads and before/after decompression. A pending descriptor or zlib operation
keeps its permit until it settles; cancellation does not free a slot while its
allocation is still outstanding. The descriptor is then closed and the caller's
original abort reason propagates. This is cooperative cancellation, not a claim
that an in-progress native I/O/decompression operation is interrupted immediately.

Each file is opened once read-only/nonblocking, checked as a regular file, and
admitted from that descriptor's safe integer size before body allocation. The
same descriptor consumes at most its admitted size plus one growth sentinel;
shrinkage or observed growth fails the inspection. Snapshot inflation has an
explicit `maxOutputLength` before UTF-8 conversion and JSON parsing. Oversized
files or decoded snapshots return `MODEL_TURN_ARCHIVE_READ_LIMIT`. The two HTTP
routes expose redacted limits with 413 for size or 429 plus `Retry-After: 1` for
overload. Storage, gzip and JSON errors keep their existing failure semantics.
The output cap uses the documented Node 22 convenience-method
[`maxOutputLength` option](https://github.com/nodejs/node/blob/v22.x/doc/api/zlib.md#class-options).

These are encoded-payload and concurrency limits, not a measured heap/RSS cap.
UTF-16 conversion, parsed object overhead, zlib state, response serialization and
slow-client response retention require separate process measurements and bounds.
The API conversation-state load that precedes archive inspection is also outside
this admission. An archive above these inspection limits remains on disk; it is
not truncated or evicted to make inspection succeed. A same-size concurrent
rewrite is not claimed to be an immutable filesystem snapshot.

Dispatch capture and immutable v2 markers, retries, outcome writes, historical
v1 outcome compatibility, canonical history, caches and live/approval/recovery
ownership are unchanged. In particular, dispatch capture still has its existing
clone/serialization allocation cost and best-effort failure handling. This read
patch neither identifies the original #520 provider crash's cause nor closes
#569's live-workload acceptance or awards a performance grade.

## Focused validation plan

All new runtime cases are authored and unrun locally. Queue should own any
execution and predeclare its process/container budget and original deadline.
Use disposable fixture directories and local SDK fixtures; no paid provider,
private workspace, diagnostic replay or live endurance is required.

1. Run `modelTurnArchiveReadBounds.test.ts` and
   `modelTurnArchiveReadRoutes.test.ts` on the exact candidate. They cover exact
   UTF-8/gzip boundaries, decoded expansion, pre-allocation compressed rejection,
   descriptor growth/shrinkage and unsafe sizes, overload without a waiting task,
   failure/cancellation cleanup and permit lifetime, immutable history/outcome
   application, v1 compatibility,
   sparse over-limit files/media, one-slot media retrieval, HTTP 413/429, and
   preserved storage/404 behavior. Fixtures use tiny compressed data and sparse
   files; they do not inflate a default 64 MiB payload merely to test a limit.
2. Include unchanged `modelTurnArchive.test.ts`,
   `modelTurnArchiveAdapter.test.ts` and `conversationStateCache.test.ts` in the
   focused request. Retain `executionOrdering.test.ts`, capped-child cleanup and
   HTTP-400 oracles in ordinary CI. Its unchanged 20k case is a separate workload
   requiring its own Queue entry, budget and deadline; no expired diagnostic
   grant authorizes replay. Collect original reports, exact revision,
   invocation/retry counts and failures.
3. Use distinct omission controls for compressed admission, decoded
   `maxOutputLength`, and the public admission wrapper. Expect failure of the
   relevant quota/no-task/allocation oracle, without changing tests or raising
   their limits. Controls need their own reviewed Source and Queue admission.
4. On hosted Linux/Windows, run the unchanged semantic typecheck, default-heap
   production build and ordinary suites at the candidate's exact merge. Existing
   #803 cancellations and older complete/component results remain separate.
5. Any later warmup/retained-memory experiment must independently declare its
   concurrency, byte and process budgets and collect heap/RSS/external memory
   and allocation samples. It must include response lifetime and active/paused
   ownership. No such runtime qualification transfers from this source proposal.
