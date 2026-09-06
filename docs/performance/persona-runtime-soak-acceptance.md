# Runtime-backed Persona soak acceptance

Issues [#459](https://github.com/mario-andreschak/FLUJO/issues/459) and
[#489](https://github.com/mario-andreschak/FLUJO/issues/489) define the
multi-week acceptance proof for parent epic
[#448](https://github.com/mario-andreschak/FLUJO/issues/448).

## Run modes

`npm run soak:personas:quick` is a non-authoritative three-day smoke run.
`node scripts/run-persona-soak.mjs --infrastructure --days=28 --activities-per-day=20 --with-learning`
executes the full workload, learning and fault matrix as a **non-authoritative infrastructure gate**.
It requires every supported runtime criterion. The three undefined numeric contracts
remain visible as optional `not_evaluated` verdicts in this mode; they are still
required and fatal in release acceptance mode. An infrastructure pass cannot close #448.

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
checksum manifests, and retains them for 90 days. Scheduled runs continue to
target the exact default-branch tip identified by `github.sha`.

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
criterion records. `persona-soak.md` is the reviewer summary.

Each registered criterion records:

- a stable ID and required/optional policy;
- `passed`, `failed`, or `not_evaluated`;
- observed values and the threshold/invariant;
- the contract source and runtime provenance;
- a failure reason for every non-passing verdict.

The validator rejects unknown, missing, duplicate, or malformed criteria,
identity/configuration mismatch, non-canonical JSON, inconsistent JSONL, or
missing Markdown identity. In an acceptance run every criterion is required, so
both `failed` and `not_evaluated` are fatal. Smoke-only optional criteria remain
visible and cannot be mistaken for acceptance.

## Metric definitions

Recall precision uses deterministic relevant memory IDs returned by the real
`searchPersonaMemory()` boundary. Day-28 precision may drop by at most five
percentage points from day 1. Recall and append latency use raw
`performance.now()` samples and nearest-rank percentiles. Event continuity
requires unique event IDs, internally adjacent retained sequence numbers, and
daily retained ranges that overlap or directly follow the prior checkpoint so
retention cannot conceal a gap. Split-brain is
derived from overlapping persisted lease intervals observed before pruning.
Stranding and stuck state come from final lease and runtime projections.

Issue #459 specifies that collection state, event-append cost, and resident
memory must be bounded/flat, but it does not provide numeric collection caps,
flatness tolerance, or resident-memory ceiling. The harness records the actual
daily observations and marks these three acceptance criteria
`not_evaluated`. This is deliberately fatal for authoritative runs until a
reviewer commits the missing numeric contracts; the implementation does not
invent passing defaults.

The infrastructure mode is a separate executable regression gate, not a relaxation
of that release contract. It was introduced in #505 after reviewing #448, #459 and
#489 and the explicit prior decision not to manufacture numeric acceptance bounds.

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
the public internet, and neither resolves the three numeric soak contracts.

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
