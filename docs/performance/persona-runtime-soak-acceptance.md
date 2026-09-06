# Runtime-backed Persona soak acceptance

Issues [#459](https://github.com/mario-andreschak/FLUJO/issues/459) and
[#489](https://github.com/mario-andreschak/FLUJO/issues/489) define the
multi-week acceptance proof for parent epic
[#448](https://github.com/mario-andreschak/FLUJO/issues/448).

## Run modes

`npm run soak:personas:quick` is a non-authoritative three-day smoke run.
`node scripts/run-persona-soak.mjs --infrastructure --days=28 --activities-per-day=20 --with-learning`
executes the full workload, learning and fault matrix as a **non-authoritative infrastructure gate**.
It requires every runtime criterion, including the explicit collection, append-cost,
and resident-memory numeric contracts. An infrastructure pass cannot close #448.

`npm run soak:personas` is the authoritative 28-day × 20-activity configuration
with seed 459 and learning enabled. For an explicit exact-commit invocation, run
the entry point directly so npm cannot reinterpret `--commit` as its
`commit-hooks` configuration option:

```sh
node scripts/run-persona-soak.mjs --days=28 --activities-per-day=20 \
  --with-learning --seed=459 --commit="$(git rev-parse HEAD)" \
  --run-id="local-$(git rev-parse --short HEAD)"
```

The CLI accepts both `--name=value` and `--name value`, rejects unknown or
duplicate options, requires a full 40-character lowercase commit SHA, and
verifies it against checked-out `HEAD`.

For retained exact-commit proof, dispatch `persona-soak.yml` from the default
branch and provide the implementation commit separately:

```sh
IMPLEMENTATION_SHA=<full-40-character-lowercase-sha>
gh workflow run persona-soak.yml \
  --repo mario-andreschak/FLUJO \
  --ref main \
  -f commit_sha="$IMPLEMENTATION_SHA" \
  -f seed=459
```

Here `--ref main` selects the trusted workflow definition; it does not select
the implementation under test. The required `commit_sha` input does that. The
workflow rejects manual dispatches from a non-default workflow ref, checks out
the selected commit with full history, proves that it belongs to the trusted
workflow history, and verifies this invariant before dependency installation:

```text
commit_sha input == checked-out HEAD == runner evidence SHA
                 == validator expected SHA == retained artifact-name SHA
```

It then invokes the Node entry point with the authoritative 28 × 20
configuration and learning enabled, validates the artifacts, generates SHA-256
checksum manifests, and retains them for 90 days. The harness has a 45-minute
overall wall-clock budget inside a 60-minute job limit, leaving bounded time for
teardown, validation, checksum generation, and upload. Smoke runs have a 10-minute
budget. Scheduled runs continue to target the exact default-branch tip identified
by `github.sha`.

Acceptance evidence must identify the exact checked-out commit. Local runs
derive it from `git rev-parse HEAD`; controlled runs set `FLUJO_SOAK_COMMIT`
from the selected target. A smoke artifact always records
`authoritative: false` and cannot close #448.

## Runtime provenance

The harness creates a persisted Persona and invokes the production factory,
mailbox router, durable dispatcher, Activity/lease stores, runtime
reconciliation, segmented event log, memory store/search, Behavior proposal,
outcome-metric, and automatic-rollback APIs. The model boundary is deterministic
and offline; persistence, routing, fencing, reconciliation, search, and learning
are not simulated.

Ordinary workload items are persisted with automatic pumping disabled and drained
in bounded, order-preserving batches between steering inputs. A pump reconciles the
durable dispatch history once, serially claims and executes every queued Activity,
and performs a final reconciliation. Every individual dispatch is still verified by
the dispatcher's durable completion waiter. The batch pump and each waiter use real
30-second wall-clock bounds while sharing the run's overall budget; virtual simulated
time cannot stall these bounds.
The dispatcher is quiesced in `finally`, including after a timeout, so active work and
wake timers cannot contaminate later regression suites.

Every generated workload source ID is reconciled to exactly one terminal
Activity and the exact ingress-specific mailbox shape. Ordinary ingress expects
one mailbox record; steering expects one host plus one delivered related record
and no second Activity. Persona ID, mailbox-to-Activity link, active Behavior
binding, and revision must agree. Attempted, accepted, completed, failed,
duplicate, and unresolved counts are separate in both daily and final evidence.

## Fault matrix

The seeded schedule executes lease expiry, concurrent claimants, graceful
dispatcher replacement, a real child-process kill/restart, and administrative
recovery. Each handler emits a stable fault ID with before/fault/after snapshots
from persisted mailbox, Activity, lease, event, and runtime projections.

Lease expiry explicitly attempts completion with the stale fence and requires
rejection before a valid higher fence can complete. Concurrent claimants require
exactly one owner. Dispatcher replacement drains a persisted dispatch.
Process-boundary recovery must fail closed without replay or a live lease.
Administrative recovery must leave an idle coherent runtime.

## Evidence and fatal semantics

`persona-soak.json` is canonical, key-sorted evidence.
`persona-soak.jsonl` contains typed run, daily metric, reconciliation, fault, and
criterion records. `persona-soak.md` is the reviewer summary. The harness creates
`persona-soak-progress.jsonl` before runtime work begins, checkpoints it after every
simulated day, and records the active phase/activity on failure. Completed-run
checksums cover this progress log as well as the three final artifacts. The final three
artifacts are still written only for a complete run, so partial progress can never
be validated as acceptance evidence.

Each registered criterion records:

- a stable ID and required/optional policy;
- `passed`, `failed`, or `not_evaluated`;
- observed values and the threshold/invariant;
- the contract source and runtime provenance;
- a failure reason for every non-passing verdict.

Evidence schema version 2 is required by both the producer and standalone validator;
older or future versions fail closed. The validator rejects unknown, missing,
duplicate, or malformed criteria, identity/configuration mismatch, non-canonical
JSON, inconsistent JSONL, malformed lease-pruning proofs, or missing Markdown
identity. In an acceptance run every criterion is required, so
both `failed` and `not_evaluated` are fatal. Smoke-only optional criteria remain
visible and cannot be mistaken for acceptance.

## Metric definitions

Recall precision uses deterministic relevant memory IDs returned by the real
`searchPersonaMemory()` boundary. Day-28 precision may drop by at most five
percentage points from day 1. Recall and append latency use raw
`performance.now()` samples and nearest-rank percentiles. Event continuity
requires unique event IDs, internally adjacent retained sequence numbers, and
daily retained ranges that overlap or directly follow the prior checkpoint so
retention cannot conceal a gap. Split-brain is derived from overlapping persisted
lease intervals observed before pruning. Before each guarded deletion sweep, the
harness records a SHA-256 snapshot of the full recovery-state view and keeps a
cumulative proof of immutable acquisition/fencing fields; duplicate tokens or
changed immutable fields fail immediately. The strict pruning reference view covers both current Persona-sharded
Activities and legacy flat records, rejects unverifiable candidates, and asserts the
retained history is at most 50 after every sweep. Stranding and stuck state come from
final lease and runtime projections.

The #489 acceptance repair commits the following numeric contracts for the fixed
28 × 20 workload:

- Every detailed runtime collection stays at or below `2 × generated activities +
  128` total records (1,248 records for the authoritative workload). Daily maximum
  uncompacted counts are `mailboxItems <= 500`, `activities <= 200`,
  `flowDispatches <= 200`, and `leaseHistory <= 50`. Missing collections and new
  uncontracted collections fail closed. These values include deterministic fault
  overhead while matching the production compaction and soak lease-pruning policies.
- Event append flatness compares the median daily p95 over the first seven days with
  the final seven days. The final median must be no more than twice the baseline,
  with a 20 ms noise floor, and every daily p95 must remain strictly below 150 ms.
  The windowed median tolerates a single noisy CI checkpoint without hiding sustained
  degradation; the absolute ceiling prevents a slow-but-flat run from passing.
- Final RSS growth from day 1 is at most 256 MiB and peak RSS is at most 768 MiB.
  The growth limit detects accumulation while the peak ceiling bounds allocator/GC
  excursions on the pinned Node 22 controlled runner.

All three criteria are evaluated from daily runtime observations in infrastructure
and acceptance modes. A missing, failed, or `not_evaluated` verdict is fatal.

## What this soak does not prove

The clock is virtual and every input is generated by the harness. The harness
replaces the complete `runFlow` boundary with deterministic successful output;
the seven ingress labels do not execute their UI/scheduler/meeting entry points.
The hard-crash invariant intentionally accepts safely rejected failed work,
not automatic replay or accomplishment of the interrupted task. Recall checks
one exact lexical fact and daily irrelevant facts. Learning uses a manually
approved candidate and manually seeded outcome samples. None of these checks
demonstrates real-model planning, tool use, account creation, environment setup,
one-goal autonomous continuation, or marketing outcomes.

The separate [ongoing-goal acceptance](persona-goal-acceptance.md) uses actual
flow execution and MCP tools, supports a live Codex model, and verifies concrete
external effects from one initial goal. The opt-in
[Persona goal endurance tier](persona-goal-endurance-acceptance.md) adds real elapsed
time, three OS-process epochs, scheduled controls and independently audited effect
reconciliation. Neither controlled scenario proves weeks of unattended operation on
the public internet; the numeric contracts above apply only to the deterministic
runtime-backed soak on the pinned controlled runner.

The soak-scale recall observation uses the same production search boundary. The
separate controlled 50,000-item gate, documented in
[persona-memory-recall-benchmark.md](persona-memory-recall-benchmark.md),
provides the strict release-scale p95 `< 150 ms` proof.

## Learning proof

With learning enabled, the harness persists baseline successes, compiles and
approves a real proposal, activates its new revision, persists the minimum
regressed outcome sample set, invokes production outcome evaluation, and
requires a `rolled_back` metric/proposal plus restoration of the base active
revision. Proposal, metric, revision, sample-count, and automatic-rollback time
are retained in evidence.

## Epic closure

Do not close #448 because the harness or workflows merged. For the proposed
release SHA, a human reviewer must attach to #448:

1. the successful authoritative soak workflow and JSON/JSONL/Markdown artifact;
2. the successful controlled 50k benchmark workflow and JSON artifact;
3. artifact checksums, workflow/run IDs, runner metadata, reviewer/date, and the
   identical release commit SHA.

If any required verdict is failed or not evaluated, or the two commits differ,
the epic remains open.
