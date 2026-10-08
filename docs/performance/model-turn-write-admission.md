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
buffer. Shared references are charged for every serialization occurrence;
only references on the active recursion path use a bounded circular marker.
The canonical snapshot estimator measures the raw clone input without field
omission. Archive-write estimation shares the sanitizer's omission policy:
environment, cancellation and secret fields are omitted before reading their
values, and private object graphs become an opaque marker. Ordinary graph
inspection uses own data descriptors; proxies, non-omitted accessors and
oversized graphs fail admission without running their hooks or getters.
Conservative rejection can occur below
actual available memory. These thresholds have not been ratified as the #569
operational budget and may reject an original-shape large-context dispatch.

Actual Zod schemas use the official `z.toJSONSchema` projection under an already
held full 256 MiB write reservation, then the bounded output walk runs before
sanitization and serialization. Arbitrary `toJSONSchema` hooks are not invoked.
This preserves ordinary Zod/AbortSignal SDK archive metadata without walking
private schema graphs ourselves. **The reservation does not bound allocation
inside Zod's projection implementation:** projection output can allocate before
it is measured. A schema plus hydrated media can exhaust the conservative
per-write reservation. This candidate does not claim hard bounded schema
projection or protection from an OOM within that library operation.

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
descriptors must close first. A failed close raises
`MODEL_TURN_ARCHIVE_WRITE_CLEANUP` without retrying: a FileHandle can retain a
rejected close promise, so another call is not independent proof of OS drainage.
Within a dispatch scope its original admission stays quarantined until process
exit. Temporary output is preserved. Outside a dispatch scope, bounded outcome
sidecars use the same typed cleanup error and preserve their uncertain temp;
they do not own a dispatch-write reservation. This is a file ownership guarantee,
not process-wide admission of all outcome writers. Original operation and
close failures remain linked. Cancellation does not recycle a reservation while
its compression/write/close is in flight.

Canonical history, active/paused/approval/recovery ownership, provider retry
identity, existing v2 outcome sidecars and archive-read limits are retained.
This change does not bound all earlier wire preparation, provider/library
allocations, live histories, folded subflow outputs, OS buffers, or process
memory. It does not qualify original default-heap Windows/Linux runtime,
installed artifacts, Persona elapsed endurance, or live-provider operation.

Prospective controls cover shared byte/count pressure, before-clone rejection,
pending siblings, reentrant/escaped scopes, repeated-reference expansion, and propagation
through the actual ModelHandler/OpenAI SDK/archive path with a disposable
loopback HTTP fixture. SDK internal retries are disabled in that fixture to
join each observed boundary to one HTTP request. A small real HTTP 400 followed
by continuation checks immutable outcomes and retained canonical history; it
does not replace the historical large-context negative control. Shared budgets
and simulated close faults are ownership controls, not allocation profiles.
The SDK fixture injects actual Zod/AbortSignal/environment metadata into the
ordinary adapter's archive observation while using the actual ModelHandler,
adapter, SDK HTTP client, archive writer and loopback provider. It does not
qualify a native agent SDK's schema execution. The outcome fault control writes
actual temp bytes and reports an injected ambiguous result after independently
observed OS close; it asserts the production writer preserved the temp and old
committed outcome. It is not a genuine OS close failure. Permanent scoped close
quarantine requires a separately isolated worker control so the unresolved
reservation and fixture survive until that worker exits; that control is pending.

Further qualification requires fresh original-shape large-context and media
workloads through the actual ModelHandler, meaningful admission-off negative
controls on disposable Source, real write/close failure observations, declared
heap/RSS/external/cgroup metrics and operational thresholds. Keep the original
fatal production confirmation open independently of this controlled evidence.
