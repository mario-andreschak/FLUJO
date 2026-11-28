# Persona runtime retention policy

Status: **Accepted configuration; each workspace switches cleanup on by itself (#481)**

Decision owner: issue [#479](https://github.com/mario-andreschak/FLUJO/issues/479)

Related implementation: runtime compaction [#453](https://github.com/mario-andreschak/FLUJO/issues/453), guarded lease-history pruning [#478](https://github.com/mario-andreschak/FLUJO/issues/478), and the self-finishing rollout [#481](https://github.com/mario-andreschak/FLUJO/issues/481). Completion-triggered compaction from [#477](https://github.com/mario-andreschak/FLUJO/issues/477) was removed in #481: the hourly sweep is the only writer.

## Policy decision

The checked-in runtime policy is:

| Record kind | Age cutoff | Newest detailed records | Eligible terminal state | Storage action |
|---|---:|---:|---|---|
| Mailbox item | 30 days | 500 | `completed`, `rejected`, `coalesced` once delivered | Clear summary and payload reference; retain identity, state, timestamps, idempotency key, and admission digest. |
| Activity | 30 days | 200 | `completed`, `cancelled`, `error` | Clear instruction context, entry payload, resource/error/outcome references; retain identity, state, lease/recovery, outcome, and audit fields. |
| Flow dispatch | 30 days | 200 | `completed`, `cancelled`, `error` with settled projections | Clear execution inputs and transient maintenance/routing/resume details; retain request/idempotency digests, admission/activity linkage, state, and timestamps. |
| Specialist call | 30 days | 200 | its Activity is terminal | Clear the Flow snapshot, output and error; retain the receipt and a payload digest. |

The policy values are checked-in constants in `compactRuntime.ts`. They are deliberately independent of behavior maintenance's separate 30-day/newest-100 policy. There are no environment overrides; changes require code review with storage, recovery, audit, and latency evidence.

Age and rank are joined by OR: an eligible record is compacted when its timestamp is strictly older than the cutoff (`timestamp < now - retentionMs`) or its zero-based newest-first rank is at least the configured cap. A record exactly at the cutoff remains detailed. Equal timestamps are ordered by descending record ID, which makes repeated sweeps deterministic.

A record is rewritten only when nothing unfinished still uses it, its cleaned-up form passes the stored schema with every identity field unchanged, and it gets smaller. Each sweep writes at most 100 records per collection and Persona. Partial sweeps are safe to retry because compacted records are excluded from later writes.

## Execution and persistence

Each workspace either measures (`shadow`) or cleans up (`active`). It starts by measuring and moves between the two by itself, as described in [persona-runtime-retention-rollout.md](./persona-runtime-retention-rollout.md).

While cleaning up, the hourly sweep rewrites mailbox items, Activities, dispatches and specialist calls under the Persona runtime lock. Every write needs a grant from the rollout control, which re-checks the stored mode before each record. The dispatch adapter uses the shared schema-validating persistence path, so compacted records reload through the same schema used by dispatch and reconciliation.

A compacted mailbox item keeps `admissionDigest`, a SHA-256 digest of the admitted request (the fields an idempotency key promises not to change). A retry is compared with that digest, so it is still recognised as the same request after `summary` and `payloadRef` were removed, while different work under the same key is still refused.

One sweep passes one timestamp to every collection. Work is bounded per collection and never runs on mailbox admission, delivery or Activity completion.

A failed write stops that Persona's run and sends the workspace back to measuring. Partially completed sweeps are safe to retry.

## Lease-history boundary

Lease history is not part of soft cleanup: its small records gain nothing from it. `prunePersonaLeaseHistory` is the #478 deletion path. It has no switch of its own: it runs only while the workspace's measured cleanup is "active", as described below. It may delete count-excess `released` or `expired` acquisitions only after the current authority head, ownership, fencing-token history, and referenced terminal Activities are proven under the runtime lock. It retains the newest 1,000 terminal acquisitions by default and limits each sweep to 100 deletions.

Old runtime event segments are removed after 90 days, keeping the newest 30. This also happens only while the workspace's measured cleanup is "active".

This separation keeps soft cleanup from ever authorizing irreversible audit deletion.

## Rollout and rollback

There are no rollout stages to run by hand. Each workspace measures for at
least a week, switches cleanup on when its own runs pass the rules, and switches
back on any anomaly. Going back stops new writes at once; detail already removed
stays removed. Lease pruning stays off by default and is not part of this
rollout.
