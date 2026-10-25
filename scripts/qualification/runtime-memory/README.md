# Runtime memory qualification v1

Prepared equipment, not an endurance result. No pilot or 24-hour qualification
has been run from this source. The native equipment tests do not execute FLUJO.
Qualify the final merged runtime revision, including the Subflow preparation,
conversation-cache, sequence scanner/registry and output-fold recovery fixes;
do not use this harness's earlier base revision. The harness requires the
public sequence, output, publication, ingress, rate and shared allocation
diagnostic APIs and fails if they are absent.

The runtime process loads the actual source once and uses the installed OpenAI
SDK, real flow/model catalogues, encryption, `runFlow`, Subflow prep/exec/post,
checkpoints, persistence, archive/media APIs, stream primitives and cache. The
only provider is a separate, bounded loopback process. Native socket/TLS/child
process guards reject accidental external transport. There are no Jest mocks,
module resets, forced GC, heap overrides, cache-map clearing, paid providers or
production data. A matching installed dependency tree can be supplied separately;
the loader checks its lock and records source/SDK hashes. This is a source
qualification, not packaged-app startup, a browser, or Next route qualification.

Each batch creates fresh conversation IDs in one fixed workspace and catalogue.
It restores a materialized 2,000,000-character parent plus eight children of
3.6, 4.0, 4.4, 4.8, 5.2, 5.6, 3.8 and 4.2 million characters. These are synthetic
ASCII histories, not original transcripts or tokenizer counts. Three completed
lanes are explicit saved fixtures, not invented past provider calls. The restored
active invocation is three completed, one failed and four queued lanes. The real
parent graph must reuse it, fold it and persist terminal parent/child histories.
The pool admits at most four simultaneous children; the coordinating parent is
an additional waiting `runFlow` owner. Physical provider concurrency is at most
four. Every admitted child is checked against fixed provider outcome counters,
its logical archive dispatch count and its durable lane/history. Child 3 must
have exactly one permanent 400 with the exact provider code and marker; child 4
must have exactly two physical requests, one 429 and one exact completion marker.
Children 5–7 must have exactly one matching completion. A child with zero
requests is accepted only with a typed archive-memory refusal and no logical
dispatch; arbitrary lane errors fail. Completed fixtures must never redispatch.

Other controls exercise a held live request, a debugger pause, real unread and
disconnected SSE bodies, SDK retry, explicit same-conversation `runFlow` retry
after a permanent 400 with distinct archive dispatch IDs, pre-SDK archive
refusal, and actual media write/read. Canonical hashes and real SDK archives are
checked. The unread body exercises production byte queues, not browser/TCP
backpressure. The live provider request remains physically held until explicit
release; disconnect and slow-consumer cleanup must remove the subscriptions and
permits while the run still owns that request. The loopback provider retains
fixed counters and bounded markers, never call histories.

Restored invocations explicitly use separate presentation. The real graph must
persist one deterministic fold message per lane, a matching fold receipt and an
acknowledged continuation. The harness reloads that actual durable snapshot and
passes stale success and failure results through production Subflow `post()`;
identities, captured state and the durable commit must remain unchanged without
another provider request. This tests durable late-result replay, not an injected
process crash, ambiguous storage write, or every recovery failure mode.

Before measurement, three fixed small owners are parked through two warmup
batches and at least 31 real minutes: debugger, tool approval, and an unknown
effect checkpoint. The last is a deliberately unacknowledged local file write
surrounded by the actual tool checkpoint APIs; it is not described as a remote
MCP failure. Real cache sweeps must preserve owner identity and durable history.
The approval is rejected through the shared approval API; the local effect is
read back and reconciled through checkpoint APIs; all three finish through
`runFlow` and persistence. Runtime statuses are never manually cleared to obtain
eviction. Only then does the separate measurement epoch start.

`profile.cjs` predeclares the envelope: two CPUs and 2 GiB aggregate memory,
application RSS at most 1 GiB, provider RSS at most 384 MiB, no swap on Linux.
Windows uses a Job Object with two CPUs, two child processes and 1920 MiB shared
memory, reserving 128 MiB for the supervisor. Linux requires an already enforced
cgroup v2 with at most two CPUs, 2 GiB and zero swap; it does not silently run
unlimited. OS RSS/handle or FD samples are independent of runtime samples.
OS guard polling and full OS evidence both remain at 1 Hz. Each serialized OS
record is bounded to 656 bytes (explicit LF on both platforms), and the existing
100,000-record limit projects at most 65,600,000 bytes, below the unchanged 64 MiB
file allowance. This projection is checked before child admission; an oversized
record fails immediately. The longest supervisor deadline is 92,640 seconds,
including all warmup, parked and drain allowances. No evidence is downsampled.
Linux receipts parse and preserve numeric `memory.events` before/after values
and deltas. Increases in `oom`, `oom_kill`, or `oom_group_kill` fail qualification.
Increases in `low`, `high`, and `max` remain reported reclaim-pressure evidence:
durable writes can reclaim page cache at the unchanged memory cap without an
OOM. Counter resets, malformed records and missing evidence fail measurement.
This distinction does not relax the application RSS, aggregate memory, CPU or
zero-swap requirements.

Runtime samples include heap, RSS, external, ArrayBuffers, CPU, GC, event-loop
delay, resource counts, admissions, queues, cache/replay/sequence registries,
archive read/write pressure and dispatch counts. Three short inspector allocation
sampling windows produce bounded top-allocation summaries, not heap snapshots.
They start after inventory/control I/O and immediately before materializing the
first warmup batch, the first batch at or after hour two (first measured pilot
batch), and the last scheduled measured batch. Sampling readiness is awaited
before batch work; windows cannot overlap. Each summary records label, epoch,
batch, monotonic start/end timestamps, actual duration and measured batch overlap.
Fast batches may leave an idle remainder in the same 15-second window; this is
reported explicitly and is not treated as whole-batch attribution. The three
compact timing receipts and summary hashes are included in the final receipt.
All evidence files and stdio are capped. Instrumentation failure, cap exhaustion,
timeout, missing process exit, missing stdout/stderr EOF, source changes, or a
quarantined descriptor prevents success. The supervisor never accepts a killed
process as clean settlement or as proof of an OOM. Drain checks require public
sequence scanner/append/commit counters and output reservations to reach zero;
quarantined scanners fail. Durable sequence keys may remain within their fixed
capacity, without admission refusals.

Publication owners, allocation/retained bytes, writer queues, chains, fences,
recovery receipts and quarantined writer slots must all settle to zero. Ingress
owners/parsers/reservations, all shared allocation slots, archive read allocation
and cleanup failures, and cache loads must also reach zero; the workspace gate
must be unblocked. Rate keys and bytes may remain within their fixed capacities
because quota expiry is lazy. Unexpected rate/capacity refusals fail. Historical
rejection/expiry counters are evidence, not live owners. Collecting ingress/rate
diagnostics does not turn these direct runtime controls into HTTP route tests.

After initialization and warmup, endurance measures at least 24 elapsed hours
in the same process, then performs a separate 31-minute natural TTL drain.
Every hour from hour 2 through hour 23 needs at least three drained samples.
Relative to hour 2, every later hourly minimum must stay within 128 MiB for
RSS and for **heapUsed + external measured in the same sample**. Heap, external
and ArrayBuffers are also reported separately. ArrayBuffers overlap external
and are not added twice. These no-forced-GC low-water marks are an operational
retention proxy, not proof of object reachability or leak freedom. Final cache
entries, protected owners and active admissions/queues must be zero.

## Pilot and storage plan

Run only after coordination with the root agent and after other heavy acceptance
work finishes. There is no automation and no user approval prompt in these tools.
A pilot runs the same warmup/owners, then two measured batches at the candidate
450-second cadence, then the full natural drain. Expect roughly 77 minutes plus
initialization and work, not a short loop disguised as endurance.

Run a pilot separately on Windows and Linux at the same source revision. Use a
new output directory outside every checkout. Linux requires
`/opt/flujo569/qualification/<phase>/output` on the owned ext4 filesystem; its
full dataset, samples, archives, home and child stdio never use DrvFs/9P. Windows
keeps its native output directory. Both consume the measured physical C: backing
volume. Preserve the complete directories, including failed receipts:

```text
python -B scripts/qualification/runtime-memory/supervise.py --mode pilot --root ABSOLUTE_SOURCE --dependencies ABSOLUTE_MATCHING_INSTALL --node ABSOLUTE_NODE --output ABSOLUTE_NEW_PILOT
```

The command must be launched through a foreground owner with current physical
disk admission and a final outer settlement receipt; a bare invocation fails
closed. On Linux use the owned 2-CPU/2-GiB, swap-disabled cgroup. The supervisor
verifies its actual `/proc/self/cgroup` membership is the declared `workload`
child of `FLUJO_569_CGROUP`, whose parent is `FLUJO_569_CGROUP_PARENT` and whose
guardian sibling shares the aggregate budget. It records both paths, aggregate
and workload memory current/peak, and both sets of OOM deltas. Fixed CPU, memory,
swap, PID and group-OOM controls are checked throughout the run. On Windows the
supervisor establishes its Job Object before any workload runs.
No installation is performed. Never use a different checkout's Jest as a test
runner: equipment tests below use Node/Python standard libraries only.

The external owner supplies `FLUJO_569_PHASE_EVIDENCE` and a unique
`FLUJO_569_PHASE_TOKEN`. Before each of the two child launches, the supervisor
writes a fresh bounded `storage-request-N.json` containing a nonce, source head,
harness/profile hashes, mode, raw plan-file hash and required combined reserve
plus the existing 20-GiB floor. The trusted Windows watcher measures C: directly
and returns matching `storage-admission-N.json` and a live watcher lease. Both
must be at most four seconds old. A Linux virtual-filesystem free-space value,
constant supplied by a caller, stale receipt or mismatched plan cannot admit a
child. The watcher continues enforcing the physical disk floor. Linux filesystem
space is checked separately. The request/response handshake changes neither
the profile nor any resource allowance.

Linux admission uses kernel `fstatfs` to require the ext4 magic, exact owned-path
containment and no symlink redirection. Existing phase directories are refused.
The runtime also checks filesystem type, device and inode before touching its
dataset. Guest ext4 free space is checked before each child admission and during
execution, while the independent Windows watcher still admits the combined
reservation plus 20 GiB against real C: free bytes for VHD growth. The full output
stays ext4 so guest page-cache allocations remain in the aggregate cgroup.

Only bounded control/heartbeat files and compact final receipts are published on
C:. After workload settlement, the guardian independently opens the actual ext4
directory and at most four regular receipt files, each at most 1 MiB, using
descriptor-based filesystem checks and no-follow opens. It hashes their original
bytes and mirrors them to the control phase's `receipts/` directory. Its receipt
binds the ext4 path, device, inode, phase/token and original file hashes. The
guardian requires both runtime and supervisor receipt filesystem identities to
match its directory descriptor before attesting completion. The Windows guard
and final MCP ownership check independently repeat that comparison for pilots
and endurance runs. Copying old receipts into a replacement ext4 inode fails.
The Windows guard also rechecks the mirror bytes. Failed datasets and partial mirrors
remain preserved and cannot qualify.

Keep both platforms' final source, canonical harness and lock-matched installed
dependencies identical before starting either pilot. The Windows launcher's
expected identities must match the current Linux source before the handshake
can succeed. Installing or refreshing WSL equipment at an earlier revision is
not a pilot and must not be carried forward as final-source evidence.

After **both** pilots pass including independent process/stdio settlement, make
a concrete plan for each target (target pilot first, other platform second):

```text
node scripts/qualification/runtime-memory/plan.cjs TARGET_PILOT_RECEIPTS OTHER_PLATFORM_PILOT_RECEIPTS NEW_PLAN_FILE 450000
```

The cadence must provide 25% headroom above both pilots' slowest batch, cannot
increase the candidate load rate, and cannot exceed 15 minutes. Storage uses
each pilot's maximum observed batch growth, multiplied by its declared 24-hour
batch count and 1.5, plus 2 GiB per platform for setup/evidence. It reserves BOTH
platform runs together plus BOTH preserved pilot datasets, with a combined
120-GiB ceiling and a separate 20-GiB free floor. An illustrative 7.5-minute
cadence has 192 batches per platform; 100 MiB observed per batch implies about
30.1 GiB per platform before pilots. Actual pilot receipts decide whether this
fits; the earlier 166-GiB host observation is not treated as current free space.
Launching a second run repeats the full conservative two-platform reservation,
so move completed evidence to another measured volume or reduce remaining work
through a new reviewed contract if that check refuses. Never simply increase
the ceiling to make a run pass.

The plan binds both successful pilot receipts, supervisor receipts, final outer
`ownership-receipt.json` files, profile,
source and filesystem provenance. Pilot paths mean the native output directory
on Windows and the bounded `receipts/` mirror on Linux. Both plan generation and
endurance preflight read the mirror's original bytes and verify every guardian
hash before accepting its parsed records; success/source assertions inside an
unattested mirror are insufficient. The remaining bindings include
source revision and the exact matching canonical source manifests. Source text,
the dependency lock and SDK entry use LF-normalized hashes on both platforms;
the source file set and TypeScript version must also match. Launch preflight
binds the installed `@modelcontextprotocol/ext-tasks` 0.2.2 package metadata,
declared export map and exact `core`, `core/v2` and `client` import-target hashes.
These three import-only package exports use their actual declared ESM files via
Node 22 `require(esm)` in the CommonJS qualification adapter. Targets must remain
regular files inside the package; unknown subpaths retain normal Node failures.
The initial dependency manifest is re-read before both provider/runtime child
admissions, compared with the successful pilots for endurance, and rechecked at
runtime completion. Missing, changed or escaping targets fail admission.
Launch preflight
also requires the same Node version and external launcher/guardian digest across
the pilot pair. The launcher verifies its equipment digest again at settlement.
Launch preflight
reads the current source/dependency files before admitting endurance, and the
runtime compares its actual loaded manifest again at completion. Full batch
identities remain in bounded `batches.jsonl`; the compact final receipt binds
each batch record by hash and preserves its storage/cadence measurements.
After agent review of the concrete plan and pilot evidence:

```text
python -B scripts/qualification/runtime-memory/supervise.py --mode endurance --root ABSOLUTE_SOURCE --dependencies ABSOLUTE_MATCHING_INSTALL --node ABSOLUTE_NODE --output ABSOLUTE_NEW_24H_OUTPUT --plan PLAN_FILE --pilot TARGET_PILOT --peer-pilot OTHER_PLATFORM_PILOT
```

No command above claims cross-platform qualification until both full elapsed
runs and their drains complete. Preserve failures and limitations in any issue
comment. All cleanup/deletion of owned evidence/worktrees must use flujo-bash
after owner settlement; this harness never deletes a durable workload dataset.

The outer owner writes its receipt only after the foreground MCP request,
actual MCP server exit with code zero, transport close and stderr EOF. Its guard
must observe child exit, stdout/stderr EOF, stopped copy threads and zero active
Job Object descendants without timeout or forced cleanup. Linux additionally
requires a successful guardian receipt with no surviving workload members and
matching aggregate/workload paths. The receipt embeds the exact inner supervisor
result and the same two physical-disk admissions. Plans reject equipment-only
receipts, absent outer evidence and any failed settlement. A 36-hour MCP client
timeout is transport capacity, not permission to change the supervisor deadline
or the unchanged 24-hour measurement and 31-minute drain.

The plan explicitly stores `expectedNode` and `launcherSha256`. Before each
provider/runtime child admission, the supervisor invokes the selected executable
to obtain its current version, and the Windows watcher independently hashes the
current launcher/guardian/cleanup helpers. Those current values must match the
plan's successful pilots, not merely each other or an earlier launch reading.
The fresh admission receipt records the current helper digest. A changed Node
binary or helper file cannot start either workload child.

Clean stdio is insufficient when a descendant closes its inherited pipes. The
inner Windows Job is queried before destructive close; active descendants cause
failure and the receipt records that forced cleanup was required. Linux records
membership before cleanup and rejects an otherwise successful command that left
members behind. Successful guardian receipts require empty pre-cleanup members,
`forcedCleanup: false`, and empty cleanup errors. All post-spawn guardian work,
including receipt writes, is inside its cleanup scope. On missing or abnormal
guardian completion, the outer Windows guard independently cleans the uniquely
owned Linux phase cgroup and records `populated 0`; it never accepts that cleanup
as qualification and never stops an unrelated phase or the whole WSL service.

## Equipment tests

```text
node --test scripts/qualification/runtime-memory/harness.test.cjs
python -B -m unittest discover -s scripts/qualification/runtime-memory -p test_supervise.py
```

They cover plan/source/settlement binding, combined disk admission, duration,
insufficient hourly evidence, RSS and combined-growth negative controls, fixed
provider counts/auth/retry/concurrency, network guards, bounded evidence,
independent stdio settlement and a Windows Job Object smoke.
Additional negative controls reject mismatched platform/source manifests,
changed launch files, missing or quarantined public diagnostics, absent/wrong
child dispatch outcomes, duplicate/joined fold identities and unacknowledged
continuations. The live-provider control crosses the former five-second timeout
and must remain held. Tests preserve their small files under
`FLUJO_QUALIFICATION_TEST_EVIDENCE` (or the OS temporary directory) for later
owner-directed flujo-bash cleanup; they do not delete files themselves.
Linux counter tests distinguish ordinary reclaim pressure from each OOM counter
increase and reject malformed/reset evidence. The first real
pilot must still establish source-loader compatibility, the approval fixture's
runtime acceptance, checkpoint ownership, terminal fold, archive permissions,
default-heap budget and eventual natural process exit. Failures are actionable
pilot results, never silently skipped controls.
