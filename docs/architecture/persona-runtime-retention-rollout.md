# Persona runtime retention rollout

Issue #481 introduces rollout control for the soft-compaction policy documented
in [persona-runtime-retention.md](./persona-runtime-retention.md). It does not
enable lease-history deletion, which remains independently gated and default-off.

## Safety contract

`FEATURES.ENABLE_PERSONA_RUNTIME_RETENTION` is the emergency master switch and
remains `false` by default. The deployment configuration is read from:

- `FLUJO_PERSONA_RUNTIME_RETENTION_MODE`: `disabled`, `shadow`, or `active`.
- `FLUJO_PERSONA_RUNTIME_RETENTION_BASIS_POINTS`: integer `0..10000`.
- `FLUJO_PERSONA_RUNTIME_RETENTION_COHORT_VERSION`: versioned cohort salt.
- `FLUJO_PERSONA_RUNTIME_RETENTION_CRITICAL_PERSONA_IDS`: comma-separated,
  deployment-managed Persona IDs excluded from every rollout cohort.

Missing or malformed configuration resolves to disabled/zero. Criticality is
only the explicit deployment list; `priority`, `autonomyLevel`, roles, and
other behavior fields never imply criticality.

Cohorts are SHA-256 buckets of the framed cohort version, workspace ID, and
Persona ID. The stable bucket range is `0..9999`; a Persona is selected when
its bucket is below the configured basis-point threshold. Changing the cohort
version is an explicit reshuffle and requires the same review as increasing the
threshold.

A sweep returns before listing Personas when the master switch is off, mode is
disabled, or the threshold is zero. Shadow mode uses the same pure plans as
active mode and performs no retention saves. Active work holds the Persona
runtime lock across list, plan, and save. Immediately before every save it
asserts lock ownership and re-reads the master switch, mode, cohort version,
threshold, and critical list. Disabling or changing the rollout therefore stops
remaining writes in an in-flight sweep; already completed atomic saves remain
valid and a later sweep converges idempotently.

The hourly scheduler runs at minute 47. It is safe to arm while disabled because
the runner performs no Persona/storage reads in the disabled path. Sweeps do not
overlap within a workspace and Persona work has bounded concurrency.

## Rollout stages

### Stage 0 — disabled baseline

- Master switch: off.
- Mode: `disabled`; basis points: `0`.
- Capture seven days of baseline mailbox scan latency, runtime storage, and
  reconciliation error rate.
- Exit only after dashboards/queries can report the gates below.

### Stage 1 — shadow

- Master switch: on.
- Mode: `shadow`; begin at 100 basis points (1%) of non-critical Personas.
- Observe at least seven days and at least 10,000 planned candidates.
- There must be zero retention saves and zero file-mtime changes attributable to
  the sweep.
- Promote only when candidate/audit-identity and admission-digest validation has
  zero failures.

### Stage 2 — 1% active non-critical

- Mode: `active`; basis points: `100`; keep the same cohort version.
- Observe for at least seven days and 10,000 attempted candidates.
- Error/write-failure rate must be below 0.1%, with zero audit-identity,
  admission-digest, crash-recovery, or reconciliation correctness failures.
- Mailbox scan p95 may regress by at most 10% from baseline and p99 by at most
  15%; no individual retention-held lock may exceed 1 second.
- Actual serialized storage for compacted collections must fall by at least 20%
  for Personas having eligible bulky records.

### Stage 3 — 50% active

- Mode: `active`; basis points: `5000`; keep the same cohort version.
- Observe for at least fourteen days.
- Apply the Stage 2 gates, plus no sustained increase above 5% in aggregate
  Persona runtime lock wait p95.
- Run the full Activity runtime, Behavior maintenance, idempotency retry,
  crash-recovery, and reconciliation gates with the master switch enabled.

### Stage 4 — manual 100% decision

A named backend owner and operations owner must review the Stage 3 evidence.
Moving to 10,000 basis points or changing the checked-in master-switch default is
a separate reviewed change. This issue does not authorize default-on.

## Required observations

Each sweep result contains a random sweep ID, mode, cohort version and threshold,
Persona counts, duration, and per-collection scanned/candidate/write/failure
counts. Per-Persona observations contain only identifiers and numeric metadata;
they never include payloads, instruction context, idempotency keys, digests,
secrets, or raw error text.

For active mode, `actualBytesBefore` and `actualBytesAfter` use measured
persisted collection sizes. `bytesBefore` and `projectedBytesAfter` report the
pure planner's serialized-record projection. Shadow mode reports the unchanged
actual size alongside that projection.

Acceptance evidence must also validate:

- retries remain coalesced after mailbox compaction;
- `admissionDigest` is present and correct where required;
- record IDs, Persona/workspace ownership, lifecycle state, timestamps, and
  audit linkage survive compaction;
- interrupted and repeated sweeps converge without duplicate effects.

## Rollback

Set the checked-in/emergency master switch to `false` and deployment mode to
`disabled` with basis points `0`. A running sweep stops before its next save.
Do not enable the independent lease-history pruning flag as part of this
rollback or rollout. Retention is additive optional-field compaction with no
schema-version bump; rollback does not attempt to restore intentionally removed
bulky detail.
