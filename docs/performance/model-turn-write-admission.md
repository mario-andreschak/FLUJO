# Model-turn archive write admission

This is a Source-only candidate on public PR #938 head
`73cda635c7b1dd0f24158036f170144ecc1cdab0`. All new controls, compiler,
lint, runtime and operational measurements are **UNRUN**. This partial #569
change does not establish the cause or resolution of the original #520 fatal
crash. The separately qualified parent-resume lease fix is outside this candidate.

The proposed limits share one process ledger across workspaces:

| Resource | Proposed limit |
| --- | --- |
| Held canonical snapshot and dispatch-write reservations combined | 512 MiB |
| One model call's canonical archive snapshot reservation | 64 MiB |
| One dispatch archive write reservation | 256 MiB |
| Concurrent dispatch archive writes | 4 |
| One local media file before archive hydration | 32 MiB |
| Descriptor-walk work / depth | 100,000 inspected values and properties / 64 |

These are conservative reservation units, not measured V8 heap or RSS. The
estimator counts source strings, JSON escaping and UTF-8 representation, object
and key allowances, array slots including holes, and full backing buffers.
Snapshot reservations use twice the estimate; dispatch writes use four times
the estimate. Local media adds a reservation before allocating its bounded
buffer. Shared object references are counted once in each walk. Unmeasurable
proxies, accessors, private prototypes and oversized graphs fail admission
without invoking publisher callbacks. Conservative rejection can occur below
actual available memory. These thresholds have not been ratified as the #569
operational budget and may reject an original-shape large-context dispatch.

ModelHandler reserves the canonical snapshot before its initial archive clone,
charges subsequent archive transcript clones, and releases that snapshot on
every outer return. The archive entry point admits a dispatch before evaluating
its deferred caller clone factory. Direct archive callers receive the same
admission. There is no waiting queue of rejected histories or callbacks.

Typed `MODEL_TURN_ARCHIVE_MEMORY_LIMIT` / `MEMORY_BUSY` failures propagate through
both ordinary optional archive catches to stop that SDK dispatch boundary.
ModelHandler returns the exact code and status details rather than continuing
after a lost diagnostic. Earlier actual provider attempts and their immutable
markers remain intact; this does not promise exactly-once execution. Other
optional diagnostic failures retain their existing best-effort behavior.

Sanitization and media-write siblings all settle before their reservation is
released. Compression and atomic writes are awaited. Explicit media and output
descriptors must close first. A failed close retains its original admission,
raises `MODEL_TURN_ARCHIVE_WRITE_CLEANUP`, and makes at most eight delayed close
attempts. Capacity remains quarantined if close is still uncertain; temporary
output is preserved. A later actual successful close releases the original
reservation only after the write task has also settled. Original operation and
close failures remain linked. Cancellation does not recycle a reservation while
its compression/write/close is in flight.

Canonical history, active/paused/approval/recovery ownership, provider retry
identity, existing v2 outcome sidecars and archive-read limits are retained.
This change does not bound all earlier wire preparation, provider/library
allocations, live histories, folded subflow outputs, OS buffers, or process
memory. It does not qualify original default-heap Windows/Linux runtime,
installed artifacts, Persona elapsed endurance, or live-provider operation.

Prospective controls cover shared byte/count pressure, before-clone rejection,
pending siblings, reentrant/escaped scopes, close quarantine, and propagation
through the actual ModelHandler/OpenAI SDK/archive path with a disposable
loopback HTTP fixture. SDK internal retries are disabled in that fixture to
join each observed boundary to one HTTP request. A small real HTTP 400 followed
by continuation checks immutable outcomes and retained canonical history; it
does not replace the historical large-context negative control. Shared budgets
and simulated close faults are ownership controls, not allocation profiles.

Further qualification requires fresh original-shape large-context and media
workloads through the actual ModelHandler, meaningful admission-off negative
controls on disposable Source, real write/close failure observations, declared
heap/RSS/external/cgroup metrics and operational thresholds. Keep the original
fatal production confirmation open independently of this controlled evidence.
