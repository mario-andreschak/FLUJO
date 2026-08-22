# Persona runtime retention policy

Status: **Accepted configuration; rollout remains gated**

Decision owner: issue [#479](https://github.com/mario-andreschak/FLUJO/issues/479)

Related implementation: runtime compaction [#453](https://github.com/mario-andreschak/FLUJO/issues/453), completion-triggered scheduling [#477](https://github.com/mario-andreschak/FLUJO/issues/477), and guarded lease-history pruning [#478](https://github.com/mario-andreschak/FLUJO/issues/478).

## Policy decision

The checked-in runtime policy is:

| Record kind | Age cutoff | Newest detailed records | Eligible terminal state | Storage action |
|---|---:|---:|---|---|
| Mailbox item | 30 days | 500 | `coalesced`, `completed`, `rejected` | Clear summary and payload reference; retain identity, state, timestamps, idempotency key, and admission digest. |
| Activity | 30 days | 200 | `completed`, `cancelled`, `error` | Clear instruction context, entry payload, resource/error/outcome references; retain identity, state, lease/recovery, outcome, and audit fields. |
| Flow dispatch | 30 days | 200 | `completed`, `cancelled`, `error` | Clear execution inputs and transient maintenance/routing/resume details; retain request/idempotency digests, admission/activity linkage, state, and timestamps. |
| Lease history | 90 days | 1,000 | `released` for the legacy soft adapter | Mark compacted without rewriting authority evidence. Irreversible count pruning is a separate #478 path. |

The policy values are checked-in constants in `compactRuntime.ts`. They are deliberately independent of behavior maintenance's separate 30-day/newest-100 policy. There are no environment overrides; changes require code review with storage, recovery, audit, and latency evidence.

Age and rank are joined by OR: an eligible record is compacted when its timestamp is strictly older than the cutoff (`timestamp < now - retentionMs`) or its zero-based newest-first rank is at least the configured cap. A record exactly at the cutoff remains detailed. Equal timestamps are ordered by descending record ID, which makes repeated sweeps deterministic.

Every completion-triggered soft-retention sweep is capped at 100 writes. Partial sweeps are safe to retry because compacted records are excluded from later writes.

## Execution and persistence

Mailbox, activity, and dispatch sweeps run after an Activity completion, under the Persona runtime lock and behind `ENABLE_PERSONA_RUNTIME_RETENTION`. The gate defaults off. The dispatch adapter uses the shared schema-validating persistence path, so compacted records reload through the same schema used by dispatch and reconciliation.

The completion path passes one timestamp to all three collection sweeps. Work is bounded per collection and happens after terminal Activity persistence; it is not performed synchronously by mailbox admission or delivery.

Failures are reported per collection and do not make a partially completed sweep unsafe to retry. Disabling the gate prevents new soft-retention sweeps.

## Lease-history boundary

Lease storage has two intentionally separate mechanisms:

1. `getLeaseHistoryRetentionPolicy` is the legacy 90-day/1,000 soft policy. It only adds `compactedAt`, does not reduce record count, and is not scheduled by runtime completion.
2. `prunePersonaLeaseHistory` is the #478 deletion path. It is independently controlled by `ENABLE_PERSONA_LEASE_HISTORY_PRUNING`, which also defaults off. It may delete count-excess `released` or `expired` acquisitions only after the current authority head, ownership, fencing-token history, and referenced terminal Activities are proven under the runtime lock. It retains the newest 1,000 terminal acquisitions by default and limits each sweep to 100 deletions.

This separation prevents the reversible soft-retention gate from silently authorizing irreversible audit deletion. The 90-day soft window does not weaken #478's proof or expand its deletion candidates.

## Rollout and rollback

Both feature gates remain off by default. Before production enablement:

- run the focused boundary, rank, schema, idempotency, crash-recovery, and reconciliation suites;
- run the 10,000-Activity bounded-growth workload to sweep convergence;
- record mailbox lane-1 baseline and contention latency, including p50 and at least p95;
- define and approve the lane-1 SLA rather than deriving one from a single benchmark machine;
- enable first in a non-critical environment and observe backlog, writes/deletes, failures, and lock duration;
- canary a small Persona cohort if cohort gating is available.

Rollback is gate disablement. Soft compaction and lease pruning are idempotent across partial sweeps; disabling a gate stops new sweeps but does not reconstruct already-cleared payloads or deleted lease records. Backups and audit policy remain the recovery boundary for irreversible deletion.
